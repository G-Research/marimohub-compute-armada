# Armada adapter: decisions for review

This document records every design decision behind `marimohub-compute-armada`, the evidence
for it, and what is still a judgement call. It is meant to be read by someone who knows
Armada and does not know this repo.

The adapter partially works. The whole provision sequence is implemented and verified
against a real local Armada: placement (submit, wait for running, cancel), exec into the
placed pod, file writes, env vars, detached process launch, and the exposed-port URL from
Armada's ingress event. Still stubs that throw: `execStream`, `readFile`, `listFiles` and
`gitCheckout`, which session capture hits at snapshot or teardown, plus `listActive` on
the client.

Every claim below is cited against the Armada source at `v0.22.7`, which is the release
pinned in `.armada-version`, in the form `path:line`. Where we had open questions earlier,
they were answered by reading that source rather than by guessing, and the decision that
follows is recorded with them.

## What this is

marimohub is a notebook hosting server. It runs each notebook kernel in a sandbox, and it
can load an external compute adapter (a JS module implementing a fixed interface) to decide
what a sandbox actually is. This repo is such an adapter: each kernel session becomes one
Armada job.

The interface we implement (`src/types.ts`) is marimohub's, transcribed by hand from
marimohub 0.3.12 because `@marimo-hub/core` is not published yet. A sandbox must support
exec, read file, list files, write files, git checkout, set env vars, start a background
process, expose a port, and destroy. `exec` is the primitive; the rest is built on it.

## The central bet

Armada is a batch meta-scheduler: submit a job (a podspec plus optional ingress and service
objects) to a queue, and it places that job on one of many Kubernetes clusters. **Its API
has no exec, attach or port-forward**, and this is confirmed rather than assumed: the entire
surface is submit, cancel, preempt, reprioritize, query status and read logs
(`pkg/api/submit.proto`, `pkg/api/job.proto`, `pkg/api/event.proto`).

marimohub requires exec. So the adapter is split in two:

- **Placement** (`src/armada.ts`): submit, follow the event stream, learn where the pod
  landed and which ingress address it was assigned.
- **Control channel** (`src/exec.ts`): exec into that pod through the Kubernetes Pod exec
  subresource, on the cluster Armada says the job is running on.

Armada's own answer to "reach into an executor cluster" is a per-cluster service called
binoculars, which exposes exactly two RPCs, `Logs` and `Cordon`
(`pkg/api/binoculars/binoculars.proto:36`). There is no exec anywhere. So stepping outside
Armada for the control channel is not us ignoring a supported path; there is no supported
path. See decision 11 for how we make that respectable rather than ad hoc.

## Decisions

### 1. Talk to the REST gateway, not gRPC

Armada ships clients for Go, Java, Scala, Python and .NET, not JavaScript. The protos carry
`google.api.http` annotations, so every RPC has an HTTP form. Rejected: generating a gRPC
client, which drags a protobuf runtime into a bundle that has to stay small, for four calls.

Consequence: the job-set event stream arrives as `application/ndjson-stream`, one JSON object
per line (`{"result": ...}` or `{"error": ...}`), and we parse it ourselves.

### 2. Hand-write the wire types, verify them against the spec

`src/armada-types.ts` covers the four endpoints we call. Rejected: generating from
`api.swagger.json`, because those calls reach 202 of the spec's 249 definitions and 165 of
them are embedded Kubernetes types we already have from `@kubernetes/client-node`. Also
rejected: generated zod schemas, measured at 0.71 MB bundled for a single schema against a
4 KB adapter, because `podSpec` pulls in the whole Kubernetes schema tree.

`scripts/check-armada-api.ts` closes the drift risk: it fetches the spec at the pinned
release and asserts all 71 fields and 3 enums we depend on still exist with the types we
read them as. CI runs it whenever an Armada-related file changes.

### 3. One Armada job per kernel session

A sandbox maps to one job, whose lifetime is the session's. Armada is built for batch work,
but nothing in it forbids a long-lived job. What does bite is a set of defaults, addressed in
decisions 7, 8 and 9. Those three settings are the difference between this working and
kernels dying for reasons the user cannot see.

### 4. Job set id and external job uri are both the sandbox id

The event stream is scoped per job set (`/v1/job-set/{queue}/{id}`), and `jobSetId` has no
effect on scheduling (`docs/creating_and_submitting_jobs.md`). One job set per sandbox makes
"watch my kernel" a single subscription rather than a filter over a shared stream, at no
cost.

Separately, **Armada has no "list the jobs I own" call.** `/v1/job/details` and
`/v1/job/status` both take explicit job ids (`pkg/api/job.proto:52`, `:78`), and
`/v1/queues/active` returns queue names, not jobs. The only lookup keyed by something we
choose is `GetJobStatusUsingExternalJobUri(queue, jobset, externalJobUri)`
(`pkg/api/job.proto:92`), which returns a job id to state map. So we set `externalJobUri` at
submit time, and reconciliation after a restart is one call per sandbox with no local state.

This was previously an open question and it had a deadline attached, because
`externalJobUri` can only be set at submit. It is now settled before the first submit.

### 5. `clientId` is the sandbox id, for dedupe

Armada discards a submission whose `clientId` matches an existing job
(`docs/creating_and_submitting_jobs.md`), so a retried provision returns the original job
instead of starting a second kernel.

### 6. Lazy job submission

marimohub's `create(id, options)` is synchronous, so it cannot submit. The job is submitted
on first use, in the optional `ready()` method, which marimohub awaits.

### 7. Always set `activeDeadlineSeconds`

**Armada assigns a default deadline to any pod that does not set one, and the shipped default
is 72 hours** (`config/server/config.yaml:65`, `docs/scheduling_and_preempting_jobs.md`).
There is also a per-resource variant: GPU jobs default to 336 hours
(`config/server/config.yaml:67`). A kernel that inherits an operator's default is killed
mid-session with no signal we control.

So we always set it explicitly, from marimohub's `compute.sessionMaxLifetimeSeconds` when
present, or a configured default. Inheriting is never correct here.

### 8. Opt out of retries with `failFast`

When the retry engine is on, a retried job keeps the same job id, gets a **new run**, and
reuses the same pod name, possibly on a different cluster (`docs/retry_policies.md`). For a
kernel that means a fresh, empty process pretending to be the user's session: the state that
made it valuable is gone. `JobFailedEvent` carries `retryable` to distinguish an intermediate
failure from a terminal one (`pkg/api/event.proto:121`), and we now model that field.

We set the `armadaproject.io/failFast` annotation (`docs/retry_policies.md`), so a failed
kernel fails terminally and marimohub compensates and offers a retry, which is the layer that
knows what the session was.

### 9. Leave the priority class alone unless told otherwise

Armada priority classes are distinct from Kubernetes ones and are set through the podspec's
`priorityClassName` (`docs/scheduling_and_preempting_jobs.md`). The shipped default,
`armada-default`, is already `preemptible: false`, and `armada-preemptible` is the opt-in
preemptible one (`config/scheduler/config.yaml:89`). `preemptible` here means fair-share
preemption; **every job can still be preempted by urgency if a higher priority class exists**,
so no class is absolutely safe.

Our config therefore treats `ARMADA_PRIORITY_CLASS` as an override, not a requirement, and
says so. The value must appear in the server's `allowedPriorityClassNames`
(`config/server/config.yaml:29`), which we cannot check from the client.

### 10. Set the termination grace period explicitly

Armada rewrites a 0s grace period to the configured minimum, rejects anything above the
maximum, and ships with a 1s minimum and a 5m maximum (`config/server/config.yaml:63`,
`docs/scheduling_and_preempting_jobs.md`). We pick a value in that range deliberately, so a
preempted or cancelled kernel gets a chance to flush.

### 11. Reach the cluster the way Lookout does

The control channel needs the API server of whichever cluster Armada placed the job on, known
only by the `clusterId` string in the event. There is no discovery API for that.

What exists is a precedent: Lookout fetches logs from binoculars in each cluster using an
operator-configured URL pattern with `{CLUSTER_ID}` substituted in
(`internal/lookoutui/src/services/apiClients/context.tsx:63`,
`config/lookout/config.yaml:35`). So the mapping is operator configuration, by design, in
Armada's own components.

We mirror that: `ARMADA_KUBECONFIG_PATTERN` takes the same `{CLUSTER_ID}` substitution, and
falls back to ambient credentials when unset, which covers both a single-cluster deployment
and a laptop. This is the shape of the thing Armada itself does, not an invention.

Exec through the Pod subresource is now implemented and verified against a real
Armada-created pod: exit codes, stderr, piped stdin, 270 KB of output and a timeout all
behave. What is not yet proven is doing it from inside the marimohub container rather than
from the host.

Also worth knowing: binoculars holds its own service account and impersonates the calling
user to read logs (`deployment/binoculars/templates/clusterrole.yaml`). If exec-from-outside
turns out to be unacceptable in a given deployment, the shaped-like-Armada alternative is a
small per-cluster service exposing exec, deployed the way binoculars is.

### 12. Find the pod by name, re-resolve the cluster

Pod naming is deterministic: `armada-<jobId>-0` (`internal/common/constants.go:5`), and
**every attempt of a job reuses that same name** (`docs/retry_policies.md`). The namespace is
the one we submitted. Pods also carry labels `armada_job_id`, `armada_queue_id` and
`armada_pod_number` (`internal/executor/domain/pod_metadata.go:4`).

So the pod identity does not need the event stream at all: job id plus our namespace is
enough, with a label selector as a fallback. Only `clusterId` is dynamic, which is what we
re-resolve from the stream. This is simpler than the design assumed and removes a class of
stale-location bugs.

### 13. Ingress: cluster IP on, annotations per job, address from Armada

The real path, read from `internal/server/submit/conversion/conversions.go:246`:

- An Ingress is generated from a ClusterIP Service, one rule per port, path `/` with
  `PathType: Prefix`.
- The host is `<container>-<port>-armada-<jobId>-0.<namespace>.` plus the executor's
  configured `HostnameSuffix` (`internal/executor/job/submit.go:165`). **We do not choose the
  hostname**, so `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` cannot dictate it. We take the address
  from `JobIngressInfoEvent`, or from `JobRunDetails.ingressAddresses`
  (`pkg/api/job.proto:32`), and never template it ourselves.
- Annotations on our `IngressConfig` are merged onto the Ingress object
  (`conversions.go:308`), on top of the executor's cluster-wide ones. WebSocket support is
  therefore an ingress-controller matter that we can influence per job, for example an nginx
  read timeout. Nothing in Armada is in the way.
- `useClusterIP` defaults to false, which produces a **headless** service, `ClusterIP: "None"`
  (`conversions.go:220`). For an ingress-backed kernel we set it to true.
- TLS is `tlsEnabled` plus `certName`, which is a secret name defaulting to `<namespace>-`.

`IngressType` has exactly one member, `Ingress` (`pkg/api/submit.proto:50`). The `NodePort`
and `Headless` values belong to `ServiceType`. The example in
`docs/creating_and_submitting_jobs.md` showing `ingress: type: NodePort` is stale.

### 14. No bucket mounting

`supportsBucketMount = false` and `mountBucket` throws, which is marimohub's documented way
to fall back to copying files in.

### 15. Configuration is validated at startup, including credentials

Library-mode adapters are constructed during marimohub's boot, so a bad `ARMADA_URL` stops
the server rather than failing at first session. We reject non-http(s) URLs, non-port values,
two auth mechanisms at once, half a basic credential, and an unreadable or empty token file,
each with a message naming the variable.

Armada offers basic, OIDC in several flows, Kubernetes-native and exec-based credentials
(`pkg/client/connection.go:39`), but on the wire they are one header. We implement two:

- Basic, `Authorization: Basic <base64(user:pass)>`, matching what Armada's own client sends
  (`pkg/client/auth/basic/credentials.go:13`). The server compares the scheme with
  `strings.EqualFold` (`internal/common/auth/basic.go:24`), as does the bearer path
  (`internal/common/auth/oidc.go:43`), so canonical casing is safe.
- Bearer, either a static token or a file re-read on every request. The file covers OIDC and
  any other rotating credential without this adapter implementing a refresh flow, and a
  rotated token is picked up without restarting marimohub.

Kubernetes-native auth is deliberately not implemented: it uses a bespoke
`KubernetesAuth <base64>` scheme carrying a CA with the token, matched case-sensitively
(`internal/common/auth/kubernetes.go:77`), and it exists for executors authenticating to the
server rather than for API clients.

Sending nothing is still a supported choice, since the quickstart runs `anonymousAuth: true`.

### 16. Ship as a bundle baked into the marimohub image

`bun build` produces a self-contained `dist/index.js`; the Dockerfile is the stock marimohub
image plus one `COPY`, with library-mode variables preset. Rejected: a ConfigMap, since the
bundle passes the 1 MiB limit once `@kubernetes/client-node` is really imported.

### 17. Pin the Armada version we target

`.armada-version` holds one version, used by the contract check. Note the local dev
environment does not honour it: the armada-operator quickstart runs `gresearch/armada-*:latest`
for everything. Those images currently serve a spec byte-identical to `v0.22.7`, verified, but
that will drift silently.

### 18. File writes and env vars mirror marimohub's kubernetes adapter

marimohub ships its own pod-exec backend (`packages/compute-kubernetes`), which is the same
control channel we use, so its semantics are the reference rather than something to invent.
A local marimohub checkout is assumed at `~/Projects/marimohub`; `src/shell.ts` transcribes
the helpers from `@marimo-hub/compute-commons` the way `src/types.ts` transcribes the ports.

- `writeFiles` is one exec per file, `mkdir -p` for the parent plus `cat > path`, with the
  content streamed over stdin. Bytes never enter a command line, so `Uint8Array` content
  arrives verbatim and only the path needs quoting. Writes run 8 at a time (upstream's
  `WRITE_CONCURRENCY`), each exec being one websocket through the API server.
- `setEnvVars` stores vars in memory and replays them as an `export K='v'; ` prefix on every
  later command, because a running pod's environment cannot be changed. `onlyIfUnset` vars
  are exported behind a `[ -n "${K:-}" ]` guard placed after the forced exports, which gives
  the precedence marimohub's conformance suite requires: forced beats default, and a value
  the image already defines beats `onlyIfUnset`.

Two deliberate divergences from upstream: a path with no parent directory skips `mkdir`
entirely (upstream's `slice`/`lastIndexOf` fallback creates a spurious directory for a bare
relative filename), and an env var name `sh` could not export is rejected at `setEnvVars`
time with a clear error rather than surfacing as shell noise at the next exec.

In-memory env means vars set before a marimohub restart are not replayed to a reattached
pod. Upstream has the same property, and the provisioner sets env immediately before
starting the kernel, so nothing observes the gap today.

### 19. Launch the kernel detached, wait for its port in-pod

`startProcess`, like decision 18, transcribes marimohub's kubernetes adapter. The launch is
`setsid sh -lc '<cmd>' >/tmp/mh-proc-N.log 2>&1 </dev/null & echo $!`: setsid detaches the
kernel from the exec session so it survives `startProcess` returning, the log file is what
`getLogs` and every failure message read, and the echoed PID is how `kill` and the liveness
check address the process later. The outer shell is non-login because its stdout is the PID
we parse; the inner shell is a login shell so profile-provided env (a PATH with uv and
python on it) reaches the kernel, its output going to the log where profile noise is
harmless.

`waitForPort` loops **inside** the pod: a `python3` one-liner retries a TCP connect against
`127.0.0.1` under a monotonic deadline. Polling from outside would pay a fresh websocket
through the API server per probe, quantizing the wait to that round trip. The wait is
chunked (30s slices, a short 2s first slice) so a kernel that dies gets noticed at a chunk
boundary: after each failed chunk, a liveness probe distinguishes "still starting" from
"crashed", and a crash throws `process exited before port N opened` with the log appended,
which the provisioner classifies as a crash rather than a timeout.

The liveness probe diverges from upstream, which uses `kill -0 $PID`. Our pod's PID 1 is
`sleep infinity`, which never reaps orphans, so a crashed kernel stays a zombie that
`kill -0` counts as alive, and the live check showed exactly that: every crash reported as
a timeout. The probe reads the state field of `/proc/$PID/stat` instead and treats `Z` or
absent as dead.

Assumptions this leans on, both satisfied by any image marimo itself runs on: `setsid`
(util-linux, present in Debian slim) and `python3` on the login-shell PATH.

### 20. `exposePort` returns the address Armada assigned, verbatim

`ingressAddress` reads `JobIngressInfoEvent` from the same job-set stream `waitForRunning`
uses. The executor fills `ingressAddresses` with one entry per exposed container port:
`hostIP:nodePort` for a NodePort service, the rule host for an Ingress
(`internal/executor/reporter/event.go:138`). The stream replays existing messages before
watching, and the event lands around Running, so by expose time it usually resolves without
waiting. An event for our job that lacks the asked-for port fails immediately: the event
carries every port at once, so a missing one is a configuration error, not something to
wait out.

`options.hostname` is deliberately ignored, per decision 13: Armada names the host, we
read it. The URL is plain `http://` because what the submit creates today is a NodePort
service; the scheme choice revisits when an Ingress config with TLS lands. That NodePort
address is only reachable from the cluster's network, which is fine for marimohub running
next to it and a visible gap for a browser on a laptop; the Ingress config is the answer
there too.

## Constraints on the first submit

Collected from `internal/server/submit/validation/submit_request.go` so the first real submit
is not a guessing game. A job is rejected unless:

- Exactly one pod. `podSpec` and `podSpecs` are mutually exclusive, and multiple pods are not
  supported (`:137`).
- `queue`, `jobSetId` and `namespace` are set (`:112`, `:129`, `:154`). `jobSetId` and
  `clientId` are length capped (`:120`, `:209`).
- Every container specifies resources, and **requests equal limits** unless the server allows
  oversubscription (`:249`, `docs/creating_and_submitting_jobs.md`).
- No `preferredDuringSchedulingIgnoredDuringExecution` node affinity, which Armada does not
  support (`:182`).
- The termination grace period is within the configured bounds (`:390`).
- `priorityClassName` is in the allowed list (`:230`).
- No restricted tolerations (`:436`), and container ports are unique across containers
  (`:162`).
- Each ingress config has at least one port, and a port appears in at most one ingress config
  (`:87`). Ports are only exposed if the pod declares them as `containerPort`
  (`conversions.go:79`).

GPU needs nothing Armada-specific: it is an ordinary `nvidia.com/gpu` resource request, and
the server adds the matching toleration itself (`config/server/config.yaml:55`).

## Event stream semantics

From `internal/server/event/event.go:85`, since `waitForRunning` depends on them:

- `watch: true` keeps the stream open, the server long-polling in 5s slices.
- `watch: false` ends the stream at the last existing message, which is the cheap way to
  poll once.
- `errorIfMissing: true` returns 404 when the job set does not exist yet. Proto3 JSON omits
  false, so the default is safe, but we send it explicitly rather than rely on that.
- `fromMessageId` is the resume cursor, and `EventStreamMessage.id` is what to store.

## Still open

These are judgement calls, not missing homework.

1. **Is exec-into-executor-pods acceptable in your deployment?** We know there is no
   Armada-native alternative, no API that forbids it, and that the per-cluster component
   pattern exists but exposes only logs and cordon. What we cannot know is whether an Armada
   operator would accept a central service holding cluster credentials, or would rather see
   exec added to binoculars upstream. This is the one answer that could change the
   architecture.
2. **One queue or a queue per user?** Fair share is computed per queue with a per-queue
   priority factor (`docs/scheduling_and_preempting_jobs.md`), so queue granularity _is_ the
   fairness model for a multi-tenant notebook server. We currently take a single queue from
   configuration. Whether that is right depends on how you expect tenants to compete.
3. **Is a mostly-idle interactive job a reasonable citizen of an Armada cluster?** Fair share
   is computed from resource _requests_ of running jobs, so an idle kernel costs its full
   request all session. That is a capacity-planning question for whoever runs the cluster,
   not an API question.

## What has been verified

Verified:

- Every endpoint, definition, field and enum in `src/armada-types.ts` exists in Armada
  `v0.22.7` as we describe it. Reproducible: `bun run check:armada-api`, currently 4
  endpoints, 17 definitions, 71 fields.
- Every citation in this document was read in the Armada source at that release.
- The local environment works: armada-operator's kind quickstart, REST gateway on port 30001,
  jobs submittable with `armadactl`.
- marimohub 0.3.12 loads this adapter in library mode, and a missing environment variable
  fails startup with our own error message.
- Exec into an executor-created pod works in practice: exit codes, stderr, piped stdin,
  270 KB of output and a timeout all behave (the smoke script, run from the host).
- `writeFiles` and `setEnvVars` round-trip against a real pod: a filename containing a
  quote and spaces, binary bytes read back exactly, a relative path landing in the
  container's working directory without a stray directory, forced-beats-default precedence,
  and a pre-existing `HOME` surviving an `onlyIfUnset` attempt.
- `startProcess` against a real pod: a detached `http.server` stays up after the launch exec
  ends, `waitForPort` sees its port, sandbox and per-process env reach it, `getLogs` reads
  its output, `kill` really terminates it, and a command that exits at once is reported as
  a crash carrying its log, not as a timeout (which is what the `kill -0` probe produced
  before the `/proc` liveness check replaced it).
- `exposePort` against a real pod: the URL comes back as `http://<node-ip>:<nodePort>` in
  single-digit milliseconds (the ingress event replays from the stream), and an HTTP
  request through that NodePort reaches a server listening on the kernel port.
- Build, type checks, tests and image build pass in CI.

Assumed, not verified:

- That exec works from inside the marimohub container rather than from the host; the kind
  API server certificate makes that route non-obvious (see README).
- That an interactive session survives normal scheduling behaviour once decisions 7 to 9 are
  applied.
- That the generated Ingress carries WebSocket traffic with a real ingress controller.
- The three items under [Still open](#still-open).

## Where to look in the code

| Path                          | What it is                                                               |
| ----------------------------- | ------------------------------------------------------------------------ |
| `src/types.ts`                | marimohub's adapter interface, transcribed by hand. Not ours to change.  |
| `src/armada.ts`               | Placement: submit, watch, ingress address, cancel. `listActive` stubbed. |
| `src/exec.ts`                 | Control channel: exec into a located pod.                                |
| `src/shell.ts`                | Quoting, env prefix, port waiter, transcribed from `compute-commons`.    |
| `src/sandbox.ts`              | One kernel session. Everything below `exec` is ordinary shell commands.  |
| `src/armada-types.ts`         | Hand-written Armada wire types, with the reasoning in the header.        |
| `scripts/check-armada-api.ts` | The contract check that keeps those types honest.                        |
| `README.md`                   | How to run the whole thing locally, and what failure looks like today.   |
