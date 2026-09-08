# Armada adapter: decisions for review

This document records every design decision behind `marimohub-compute-armada`, the evidence
for it, and what is still a judgement call. It is meant to be read by someone who knows
Armada and does not know this repo.

Underneath every decision sits the one question we want answered more than any other:
**is this a sensible use of Armada, or are we abusing it?** Long-lived, exec-controlled,
mostly idle interactive jobs, one job set per session, a single queue today. Our position is
that it is sensible, and the evidence exists to earn that position rather than assume it. If
you read nothing else, read [The central bet](#the-central-bet) and
[Still open](#still-open): the six judgement calls there are the ones we cannot settle
without you, and the thirty decisions exist to support them. They are written to be
checked, not taken on faith. The first of the six has since been answered, and the answer
replaced the control channel: see the note at the head of decision 11, decision 28, and
`AGENT-DESIGN.md`.

Marimohub questions will come up, and they are out of scope here: this document explains the
Armada side of the seam and only summarizes what marimohub needs from it. marimohub is open
source at `https://github.com/marimo-team/marimohub`; clone it, check out the 0.3.12 release
the interface was transcribed from, and the citations of the form `packages/...` point into
it. When a question is about marimohub's side (what the provisioner does between `create` and
`ready`, why the reconciler destroys what `listActive` returns, what happens when a user stops
a kernel), do not answer it from this document: run an agentic session with that checkout in
reach and let it read the source, the same way this document's Armada claims were answered
by reading Armada's.

The adapter covers marimohub's whole interface. The provision sequence is implemented and
verified against a real local Armada: placement (submit, wait for running, cancel),
commands run through the agent, file writes, env vars, detached process launch, the
exposed-port URL from Armada's ingress event, reading files and directories back out,
streaming a command's output, and cloning a repository. Since decision 29 the agent
answers file and process requests directly, so those operations no longer build a shell
command at all. `listActive`, the last stub, now asks Lookout
(decision 27) and is covered by tests against stubbed responses; it has not yet been
exercised against the local cluster's own Lookout.

Every claim below is cited against the Armada source at `v0.22.7`, which is the release
pinned in `.armada-version`, in the form `path:line`. Where we had open questions earlier,
they were answered by reading that source rather than by guessing, and the decision that
follows is recorded with them.

How this text exists matters too: it was written with heavy AI assistance, as was the adapter
itself. The Armada claims were gathered by agents reading the pinned release, not quoted from
human experience. We say so to calibrate trust correctly: a wrong citation is a bug to
report, not a memory to argue with, and the same machinery serves your review in reverse,
because marimohub-side questions can be answered by an agent reading that checkout, as
described above.

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
path. Decision 11 records how we made that respectable rather than ad hoc, and the note at
its head records that the reviewer rejected it anyway, and what replaces it.

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

What that leaves out is enumeration: listing the sandboxes that exist at all, with no local
state to consult, is the other half of reconciliation, and it is the one question the calls
above cannot answer because they all name a job. Decision 27 is where it went.

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

**Superseded on 2026-09-07.** The reviewer's answer to open question 1 is no. A central
service holding a kubeconfig for every worker cluster bypasses Armada and has direct power
over every cluster, which is what Armada exists to prevent. The replacement is a small agent
that runs as PID 1 of the kernel container in place of `sleep infinity`, listens on a
second port, and runs commands over HTTP. The job exposes that port next to the kernel's, and
the adapter reads both addresses from the same `JobIngressInfoEvent` it reads today (decision
20): the executor reports one address per service port for NodePort and one host per rule
for an ingress (`internal/executor/reporter/event.go:148`). Under this design marimohub
holds no Kubernetes credential of any shape, and the cluster id is never used. The design,
its pod spec and its order of work are in `AGENT-DESIGN.md`.

Steps 1 and 2 of that plan are done: the agent exists (`agent/`), the adapter talks to it
(`src/channel.ts`), the kubeconfig channel and its configuration are gone, and a notebook
session runs end to end on the local cluster through it. Decision 28 records what was
built and where it departs from the design. Everything above the seam, decisions 18
through 26, carried over unchanged apart from the one wrapper decision 28 names. The rest
of this decision is kept as written, for the record.

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
behave, and it works from inside the marimohub container, not only from the host. The
in-container route is the pattern applied literally: `dev/run-local.sh` gives the container
kind's internal kubeconfig (`https://armada-control-plane:6443`, which is in the API server
certificate's SANs; `host.docker.internal` is not) and joins it to the `kind` docker
network, and `ARMADA_KUBECONFIG_PATTERN` points at the mounted file.

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

_Since decision 29 a file write is one `PUT /files` to the agent, bytes raw in
the body, and no shell is involved: the quoting, the `mkdir -p && cat` command
and the stdin transport below are gone. What carries over: one request per
file, eight in flight, content never entering a command line, and the
divergence that a bare filename creates no spurious directory (the agent skips
the parent when there is none). The env-var half is unchanged. The text below
is kept as written._

marimohub ships its own pod-exec backend (`packages/compute-kubernetes`), which is the same
control channel we use, so its semantics are the reference rather than something to invent.
A local marimohub checkout is assumed (the introduction says where it lives); `src/shell.ts` transcribes
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

_Since decision 29 the agent does all of this itself. `startProcess` is one
`POST /process/start`: the agent parents the process in its own session, so
the `setsid … & echo $!` launch, the log-file redirection and the `/proc`
liveness probe are gone, and the exit status comes from a real `wait`.
`waitForPort` is one request the agent answers by dialling `127.0.0.1` in-pod
while watching the process, so the chunking and the `python3` one-liner are
gone too, and a crash is reported the moment it happens rather than at a chunk
boundary. What carries over: the launch still runs `sh -lc`, so
profile-provided env reaches the kernel, and a crash is still worded
`process exited before port N opened` with the log appended, which is what the
provisioner classifies on. The text below is kept as written._

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

_Since decision 30 the scheme follows the submit: `portUrl` in `src/armada.ts` wraps
the address below in `https://` when the job asked for an Ingress with TLS and
`http://` otherwise, and the "revisits when an Ingress config with TLS lands" at the end
of this decision is that revisit. The address itself is still read, never templated._

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
next to it and a visible gap for a browser on a laptop. Both answers to that gap are
marimohub's, not this adapter's: in `subdomain` exposure the browser dereferences our URL
directly, which needs a public address and is what the Ingress config will provide; in
`proxy` exposure (`MARIMOHUB_SANDBOX_EXPOSURE=proxy`) kernel traffic is forwarded through
the app, so our URL only has to be reachable from marimohub. The local environment uses
proxy exposure, and a full session works end to end through it.

### 21. Read files back as base64, and let the bytes choose the encoding

_Since decision 29 the bytes cross raw: `readFile` is a `GET /files` whose
response body is the file, and `listFiles` is a `GET /files/list` answered as
JSON, so the base64 transport, the wrapped-line rejoining and the `find`
parsing are gone. Everything decided here about meaning survives unchanged:
the encoding reported to marimohub is still chosen from the bytes (its two
consumers still disagree), an absent path is still `NOT_FOUND` with dangling
symlinks still counting as present, listing a file is still `NOT_A_DIRECTORY`,
and hidden entries are still filtered on their own name after a walk that
descends into dot directories. The agent's probe order in `agent/files.go`
preserves each of those answers. The text below is kept as written._

`readFile` and `listFiles` are the read side of decision 18, and like it they transcribe
marimohub's kubernetes adapter. Both run in a non-login `sh -c` with no env prefix, because
their stdout is a protocol value we parse and a profile script that prints anything would
corrupt it. Upstream states that rule for `readFile` and then breaks it for `listFiles`,
which goes through its ordinary `exec` path; we apply it to both.

`readFile` does not `cat`. Our exec channel returns stdout as `Buffer.concat(...).toString('utf8')`,
so any byte that is not valid UTF-8 becomes U+FFFD: a plain `cat` would silently corrupt
exactly the content decision 18 took care to carry in verbatim. The pod runs `base64`
instead, which is ASCII and survives the channel, and the adapter decodes it.

What encoding we then report is decided from the bytes, and this is the one place the two
first-party consumers disagree. `ReadFileResult` carries an optional `encoding` of `utf-8`
or `base64`, but marimohub's `readSessionArtifacts`
(`packages/core/src/services/runtime/sandboxFiles.ts:352`) takes `result.content` and never
looks at `encoding`, while `proposalCapture`
(`packages/core/src/services/content/proposalCapture.ts:201`) passes both to
`decodeProposalContent`. So reporting base64 unconditionally would store base64 as the
notebook source, and reporting UTF-8 unconditionally would corrupt an image the user
changed. We decode the bytes, return them as text with `encoding: 'utf-8'` when they are
valid UTF-8, and as `base64` otherwise. Text works for both consumers; binary is at least
intact for the one that can decode it. The base64 is re-encoded rather than passed through,
because GNU `base64` wraps at 76 columns and the decoders downstream take one line. A byte
order mark is preserved (`TextDecoder` is given `ignoreBOM: true`, which means "do not strip
it"), so a file that has one round-trips exactly.

Two smaller divergences. The path reaches `base64` by redirection rather than as an operand,
so a path starting with `-` needs no `--`, which GNU coreutils supports and busybox does not.
And an absent path is `NOT_FOUND`, not upstream's blanket `READ_FAILED`: session capture
reads four fixed paths of which several routinely do not exist (a notebook that never
rendered has no `__marimo__/notebook.html`), so "never written" is the common answer and is
worth telling apart from "could not be read". A shell `[ -e ] || [ -L ]` test in the same
command carries it, at exit code 44, so it costs no extra round trip.

`listFiles` is upstream's `find` with upstream's directory probe in front of it. The probe is
what marimohub's compute contract demands: listing a file must be `NOT_A_DIRECTORY` and never
an empty success (`packages/core/src/testing/computeContract.ts:260`), which an unguarded
`find` cannot distinguish from an empty directory. We classify on the probe's exit code (20)
rather than on upstream's stderr marker, since a pod exec gives us the exit code directly;
the marker is still printed so a failing exec explains itself in a log. Records are
NUL-separated `type<TAB>size<TAB>path`, the path last so one containing a tab rejoins intact.
`includeHidden` filters on an entry's own name, so a recursive listing still descends into a
dot directory, which is upstream's behaviour and what `readSessionArtifacts` relies on when
it enumerates `__marimo__` trees.

`find -printf` is GNU find, as it is upstream; busybox has no equivalent. That is the same
class of assumption as `setsid` and `python3` in decision 19, and holds for any
Debian-family kernel image. `base64` is coreutils and present in busybox too.

### 22. Every command goes through `sh`

_Since decision 29 this is true of commands and of nothing else: files travel
as bytes and detached processes are the agent's own children, so the reasons
below that concern redirection for reads, `[ -e ]` probes and the port waiter
no longer apply. `/bin/sh` remains the dependency of `exec`, `execStream`,
`startProcess` and `gitCheckout`; GNU `find`, util-linux `setsid` and the
`python3` waiter are no longer required of a kernel image at all. `git`
(decision 26) remains the one whole-package assumption. The text below is kept
as written._

The Pod exec subresource takes an argv, not a command line, so the interpreter is our
choice and not something the API imposes. We could exec binaries directly, `['find', path,
'-mindepth', '1', ...]`, and depend on no shell at all. We do not, because every capability
above `exec` needs shell features: the env prefix is `export` statements (decision 18), the
port waiter and the kernel launch need redirection, backgrounding and `setsid` (decision 19),
and the read and list commands need redirection and `[ -e ]` tests (decision 21). Building
those out of bare argv would mean either several round trips where there is now one, or
reimplementing a shell.

So `['sh', '-c', ...]` is the shape of every exec this adapter makes, with `-lc` where the
command runs user code and needs a profile-provided PATH. That is also what marimohub's
kubernetes adapter does (`packages/compute-kubernetes/src/index.ts:122`), so the images that
work there work here.

This makes `/bin/sh` a hard dependency of the whole adapter rather than of any one method.
It is the safest of the assumptions we make: POSIX requires it, and every Linux image that
is not `scratch` or distroless has it, whether that is dash on Debian or busybox on Alpine.
A kernel image without it fails at the first exec with the API server's own "executable file
not found in $PATH", wrapped with the pod, cluster and command by `execFailure`
(`src/exec.ts`), so the diagnosis is immediate rather than mysterious.

The narrower assumptions are the ones to watch. Most are GNU or util-linux specifics that
busybox lacks: `find -printf` (decision 21) and `setsid` (decision 19; its `--wait` flag is
no longer needed since decision 28). `base64` (decision 21) exists in both coreutils and busybox, and `python3`
(decision 19) is definitional for a Python kernel image. `git` (decision 26) is the one
that is a whole package rather than a flag: `python:*-slim` does not ship it, so a kernel
image built from scratch must install it or sessions that load from a repository fail at
`gitCheckout`.

Note what this rules out: the adapter probes for no capability anywhere. It never asks
whether `setsid` exists or whether the interpreter is `python3` or `python`; it assumes, and
a wrong assumption surfaces as that command's own failure. Upstream does probe, and
re-probes on every call (`packages/core/src/services/content/proposalCapture.ts:218` runs
`command -v python3 ... elif command -v python` per read).

If a probe ever becomes necessary, inline it into the command that needs it, the way
`listFilesCommand` inlines its directory test: a `command -v` inside the same `sh -c` picks a
branch for free, and there is then nothing to cache. Memoize only when the answer has to
reach JavaScript, for instance because it changes how we parse the output, and memoize it on
the `ArmadaSandbox` instance next to `this.pod`, never module-globally. A pod's binaries are
fixed when its image is built, so once per sandbox is the correct lifetime, and two sandboxes
may be running different images (`options.image` overrides the configured one).

The directory test in `listFiles` is not such a probe and must not be memoized: it answers
what a path is right now, and a path becomes a directory or stops being one while the kernel
runs.

### 23. `execStream` really streams, and `exec` gets a login shell

_Since decision 28 the channel underneath is the agent, not a websocket through the API
server. Closing the request now does stop the command, because the agent kills its process
group, and the `setsid --wait` wrapper described below is gone: the agent already starts
every command as a session leader, and a second session would have escaped its kill. The
group file, the `onStop` kill and the sweep were kept as belt and braces for a while and
are deleted since decision 29, which says why that became safe. The text below is kept as
written._

marimohub's kubernetes adapter implements `execStream` by running the command through its
ordinary `exec` and emitting the buffered stdout as a single chunk, because its internal exec
seam is request/response. Ours is not: `src/exec.ts` owns the websocket, and
`@kubernetes/client-node` hands stdout to a `Writable` as the data arrives. So `PodExec.stream`
forwards each chunk as the command produces it, and a `tail -f` behaves like one instead of
delivering everything at the end of a timeout.

The awkward part is backpressure, and it is why `podOutputStream` is a separate, testable
function rather than a closure inside `stream`. A `ReadableStream` will queue whatever it is
given, so a command that outruns its reader would be buffered in memory, which is exactly the
behaviour real streaming is supposed to avoid. Instead each write holds the producer's
callback until the consumer pulls. With the default queuing strategy that means the producer
is held from the first chunk, so nothing accumulates on our side; the pressure lands on the
websocket, where it belongs.

The other semantics are transcribed from marimohub's local backend
(`packages/compute-local/src/index.ts:381`), which is the one adapter that streams a real
process:

- **stdout only.** The stream carries no framing, so interleaving stderr would corrupt output
  the caller parses. stderr is still drained rather than left unread, because a full pipe
  eventually blocks the command writing to it. Upstream drains it with `child.stderr.resume()`
  for the same reason.
- **Cancelling stops the work**, but not for free. Upstream kills the process group when the
  stream is aborted, and we have to do the same explicitly, because **closing the exec
  websocket does not stop the command**. That was measured rather than assumed: against a
  real pod, a loop kept ticking after the socket closed, whether or not it was still writing
  to stdout, so not even the closed pipe reaches it. Left alone, every abandoned stream would
  leave a process spinning in the kernel's pod for the rest of the session.

  So the streamed command runs as `setsid --wait sh -lc 'echo $$ > <file>; <command>'`: its
  own process group, whose id the prologue records before the command starts. Cancelling, or
  the timeout expiring, closes the socket and then spends one more exec on
  `kill -TERM -"$group"`, the negated id that addresses the whole group, so a shell loop dies
  along with the `sleep` it was waiting on. The prologue redirects to the file and never to
  stdout, which belongs to the caller, and the argv is passed as separate entries so none of
  it needs quoting. A cancel in the instant before the prologue runs finds nothing to kill;
  that is the one gap, and it is bounded by how long a shell takes to run one `echo`.

  A cancel also releases a held write callback before closing, or the producer stays parked
  and the socket never unwinds.

- **The exit code is unreachable.** A `ReadableStream` has nowhere to put it, so a command
  that fails is a stream that ends, as it is upstream.

One deliberate difference from `exec`: `ExecStreamOptions.timeout` ends the stream rather than
failing it. `run`'s timeout rejects, because nothing has been handed to the caller yet, but a
stream has already delivered bytes and erroring would throw them away. Bounding an endless
command is what the option is for, so it truncates.

Worth knowing: **nothing in marimohub calls `execStream` today.** It is in the required method
surface (`packages/core/src/ports/adapterShape.ts:19`) and the compute contract asserts it
returns a cancellable `ReadableStream`, but no service uses it. We implemented the streaming
version anyway because the buffered one is a trap for whoever adds the first consumer: a log
view or a terminal is precisely the case where buffering looks like a hang.

**`exec` now runs `sh -lc`.** It ran `sh -c` before, which was an oversight rather than a
decision: upstream gives `exec` a login shell so an image that exposes `uv` or `python3`
through a profile script keeps working, and `exec` is where user and provisioner code arrives.
`startProcess` already used `-lc` for the kernel itself (decision 19), so the two disagreed
about the same image. The rule is now uniform and is the one upstream states: commands that
run someone else's code get a login shell, and our own protocol commands, whose stdout we
parse, get a plain `sh -c` (decisions 18, 21). The cost of a login shell is that profile
output lands in `ExecResult.stdout`; upstream accepts that for `exec`, and the protocol
commands that cannot tolerate it are exempt by construction.

### 24. A timeout kills what it abandoned, and the smoke run looks for ghosts

_Since decision 28 the deadline is enforced by the agent, which kills the process group
itself and reports the command as timed out; the adapter's own kill was a second line
until decision 29 deleted it. The smoke run now also expects no zombies at all, because
PID 1 reaps. The text below is kept as written._

Decision 23 found that closing an exec websocket does not stop the command. That finding is
not specific to streaming, and following it through turned up a live bug: `PodExec.run`'s
timeout closed the socket and rejected, so **a timed-out `exec` told marimohub the command
failed while the command kept running in the pod**. Measured, not reasoned: a loop given a
1.5s timeout was at 8 ticks when the timeout fired and 23 three seconds later.

That path has callers today, which the streaming one does not: marimohub passes
`ExecOptions.timeout`. Every timed-out command was a process spinning next to the kernel for
the rest of the session, competing with it for the CPU the pod requested.

So a command with a deadline now goes through `processGroupCommand`, the same wrapper
`execStream` uses, and `PodExecOptions.onStop` kills the group when the deadline passes.
A command without a deadline is left exactly as it was, plain `sh -lc`, so the common path
gains no dependency and no wrapper.

Two details that matter more than they look:

- The wrapper cleans up with an `EXIT` trap rather than a trailing `rm`. The live run caught
  why: a command ending in an explicit `exit` never reaches a trailing anything, and two
  group files were left behind. A trap also keeps the command's exit status, which `exec`
  reports and a trailing `rm` would overwrite with its own, and `setsid --wait` propagates
  that status in turn, which is the reason for `--wait` rather than a bare `setsid`. A
  killed shell runs no trap, so the kill path removes the file itself.
- The kill is best effort and unawaited. The caller is already being told the command timed
  out, and a failing kill has nobody to report to.

Gaps this leaves, each one a kill that never runs: a cancel or timeout in the instant before
the prologue records the group id finds nothing to kill, an `onStop` exec that itself fails is
swallowed, and a marimohub restart abandons every stream it had open without running `onStop`
at all. Decision 25 is what repairs those. We also send `TERM` without escalating to `KILL`,
so a process that ignores it survives, which nothing currently repairs.

### 25. Sweep the marks, never the processes

**Deleted on 2026-09-07, with decision 29.** The sweep existed to repair kills that the
adapter's own `onStop` could miss, and above all the marimohub restart, which abandoned
every open exec websocket without stopping anything. The agent closed that class whole: a
command dies when its request does, a restart is precisely every request dying at once,
and there is no prologue left for a kill to race. `src/sweeper.ts`, the group files,
`ARMADA_GHOST_SWEEP_SECONDS` and the `ghosts_killed` counter are gone; the backstop that
rode the sweep (`ARMADA_COMMAND_MAX_SECONDS`) moved into the agent's own deadline, as
decision 29 records. The design rule this decision defended, never kill by heuristic,
still stands and is now enforced by construction: the agent only ever kills the process
groups of requests it is serving. The text below is kept as written, for the record.

The kills in decision 24 are the normal path, and they all have the same weakness: they are
code that has to run at the moment something goes wrong. A sweep on a timer covers what that
code misses, and every sandbox runs one every `ARMADA_GHOST_SWEEP_SECONDS` (default 60, `0`
disables it).

**What it sweeps is the important part.** The obvious design, looking at the pod's processes
and killing what seems abandoned, cannot work here: a kernel pod legitimately holds the
kernel and whatever the user's notebook spawned, a `subprocess.Popen` from a cell, a training
run, a dev server, and none of those is distinguishable from a leak by looking at it. Any
heuristic, by age or CPU or parent, eventually kills a user's work, which is worse than the
leak it was meant to prevent.

So the sweep never looks at processes. Every abandonable command already records its process
group in `/tmp/mh-*.pgid` and removes it on the way out, and the sandbox knows which of those
files belong to commands it is still waiting on. A file that exists for a command nobody is
waiting on is a ghost **by construction**, not by guesswork, and a process without such a
file is never a candidate. The bookkeeping registers a file before its command is sent and
releases it in a `finally`, so the live set never lags what the pod is running.

That makes the sweep repair exactly the gaps decision 24 leaves. A cancel that beat the
prologue leaves a file with a group we never killed. A failed `onStop` leaves the same. A
marimohub restart leaves a pod full of them and no memory of any, which is the case a
per-command fix cannot reach at all and where a sweep earns its keep.

**What is tracked, and the backstop.** Every `exec` runs in a process group, not only the ones
with a deadline, and the sandbox keeps the command text, the start time and whether anyone is
still waiting for it. That matters because **only one of marimohub's ten `exec` call sites
passes a timeout** (`SandboxProvisioner.ts:389`); `packedWorkspaceRestore`, `sandboxFiles`,
`sessionLifecycle`, `proposalCapture` and `SandboxDataPreview` all call it unbounded. Without
a group file, one of those losing its socket leaves a command running that nothing can even
name, let alone kill. With one, the sweep collects it the moment the wait ends.

Knowing the command also makes the report useful: the sweep says which command it killed and
how long ago it started, and a file it has no record of is named as a leftover from a previous
marimohub process, which is the one case nothing else can repair.

On top of that, `ARMADA_COMMAND_MAX_SECONDS` (default 6 hours, `0` disables) gives up on an
`exec` that is still being awaited long past anything expected. It is deliberately not a
timeout: the caller's own `ExecOptions.timeout` is the timeout, and the unbounded call sites
above are the ones that legitimately take minutes, so a short invented deadline would kill
real work exactly the way a heuristic reaper would. Hours is the scale at which nobody expects
the command to still be running, and the alternative is a websocket and a process held for the
rest of the session while the caller waits forever. The backstop only marks the command as no
longer awaited; the sweep then kills it like any other abandoned group, so `exec` sees the
command die instead of hanging on. Streams are exempt, because how long a stream stays open is
its reader's decision.

Mechanics worth knowing:

- A file whose group is already gone is not news: the sweep removes it and reports nothing,
  because a group file outliving its process is the ordinary case for a killed shell (a
  killed shell never runs its `EXIT` trap).
- **One sweeper for the whole provider**, not a timer per sandbox (`src/sweeper.ts`). The
  per-sandbox timer was the obvious shape and the wrong one: sandboxes created together sweep
  together, so twenty kernels started at nine o'clock fire twenty exec websockets at the same
  API server in the same instant, every interval, for the life of those sessions. The work is
  inherently per-pod and cannot be batched, so the fix is not fewer round trips but fewer at
  once. `ArmadaCompute` holds the sweeper, sandboxes join it when they have a pod and leave on
  `destroy()`, and the timer exists only while something is registered.
- A concurrency cap (four in flight) is what staggers a pass: a hundred sandboxes are swept as
  a rolling queue rather than a burst, so no jitter is needed. A pass that outlives its
  interval is skipped rather than stacked, since two sweeps against one pod would have the
  second read the first's kills as unowned groups. The timer is `unref`'d, so it never holds
  marimohub's process open.
- Reaching the pod is best effort. A sweep that fails is a sweep that happens a minute later.
- When it kills something it says so through `console.warn`, because finding a ghost means a
  kill that should have happened earlier did not, and it counts them into `drainCounters()`,
  which marimohub folds into its `session_provision` line
  (`packages/core/src/services/runtime/SandboxProvisioner.ts:649`). Counters are drained
  once, at the end of provisioning, so the log line is the signal during a session and the
  counter is the one at its start.

`dev/smoke.ts` proves the whole thing against a real cluster rather than asserting it: it
times out a command, cancels a stream, plants a group nothing is waiting on, sweeps, and then
lists every process that is not PID 1 and not the shell doing the asking. The planting is
what makes the check meaningful. Without it the sweep finds nothing, since `onStop` already
killed both abandoned commands, and a check that never provokes the failure it looks for
reports a clean pod whether or not the code still works.

The stray listing reads `/proc` rather than running `ps`: the kernel image has no `procps`,
so `ps` prints nothing there and an empty result would read as a clean pod. It reports the
process state too, so a zombie left by a PID 1 that never reaps (decision 19) is
distinguishable from something still running. A healthy run kills the planted group and finds
no live strays.

### 26. `gitCheckout` is a quoted clone through the ordinary `exec`

Upstream's one-liner, transcribed: build `git clone --branch 'b' 'repo' 'target'` with every
argument shell-quoted (`buildGitCloneCommand` in `@marimo-hub/compute-commons`; its comment
records that the quoting closed a real injection hole), run it through the sandbox's own
`exec`, and throw `git checkout failed: <stderr>` on a non-zero exit. The target defaults to
`.`, the pod's working directory.

Going through `exec` rather than a bespoke pod command is the point, because of what that
path now carries (decisions 22 to 25): a login shell, so a `git` that a profile script put on
PATH is found; the accumulated env prefix, so a credential helper reading a token variable
set through `setEnvVars` works; and a process group with a `.pgid` file, so a clone abandoned
mid-transfer (marimohub restarts, the socket drops) is killed by the sweep instead of
fetching into a dead directory for the rest of the session.

`git` itself is assumed, not probed, per decision 22's rule, and it is a real assumption:
`python:*-slim` does not ship git, so this leans on the kernel image providing it, the same
way upstream's kubernetes adapter does. A missing git fails the clone with sh's own
"git: not found" in the thrown stderr, so the diagnosis is immediate.

### 27. `listActive` asks Lookout, and only exists when Lookout is configured

marimohub's reconciler needs the one question decision 4 left open: after a restart, which
sandboxes exist? A local registry would reintroduce exactly the state decision 4's design
exists to avoid, and the Armada server has no call that enumerates a queue's jobs. The
component that aggregates jobs across every executor cluster is Lookout, which is why its
UI can list jobs and the server API cannot.

So `listActive` is a paged `POST /api/v1/jobs` to Lookout:

- Filters scope the answer to our queue (`match: exact`), to the states where a sandbox is
  alive or on its way (`QUEUED`, `LEASED`, `PENDING`, `RUNNING`), and to jobs carrying the
  `marimohub/sandbox` annotation set at submit. The annotation filter is the safety
  property, not decoration: **the reconciler destroys what `listActive` returns**, and a
  queue may hold jobs that are not marimohub's, so an unfiltered answer would cancel
  strangers' work on the next sweep.
- `order: submitted ASC` with `take: 500` pages until a page comes back short, so more
  active kernels than a page loops rather than truncates.
- The response is keyed on `jobSet`, which is the sandbox id (decision 4), so the mapping to
  `ActiveSandbox` is direct and `submitted` becomes `createdAt`. A `QUEUED` job is reported
  deliberately: its sandbox is on its way and must not look reapable, and it has no
  creation time to give.

`ARMADA_LOOKOUT_URL` is optional, and the provider **advertises `listActive` only when it
is set** (`src/provider.ts`). marimohub treats a declared `listActive` as a promise:
declaring one we could not answer would fail every reconciliation sweep, where the absent
method makes reconciliation a clean no-op. Unset, this is a placement-and-control adapter
and nothing else.

The cost of leaning on Lookout is that its API is a UI's API, not a documented public
contract like the server's: the spec is a separate file
(`internal/lookout/swagger.yaml`), YAML rather than JSON. `check-armada-api` therefore also
asserts that the twelve tokens we depend on still exist in that swagger at the pinned
release, which is coarser than the structural check above and deliberately so. Whether
depending on Lookout at all is right is [still open](#still-open).

### 28. The control channel is an agent in the pod, reached like the kernel is

The answer to open question 1 (decision 11), built. The design is `AGENT-DESIGN.md`; this
records what was implemented and the places it departs from that text.

**What runs in the pod.** The kernel container's command is `/mh-agent/agent --port 8718`
in place of `sleep infinity`: a static Go binary with no dependencies (`agent/`), so the
same file runs in any Linux image. An init container from the agent's own image runs
`/agent install /mh-agent/agent` into an `emptyDir` both containers mount, which is how the
operator's kernel image stays untouched (`src/podspec.ts`). Two departures from the design's
example: the agent copies itself rather than relying on a `cp`, so its image is `FROM
scratch`; and the mount is `/mh-agent`, not `/shared`, because a user's notebook may
reasonably create `/shared`. The init container carries `100m` CPU and `64Mi` memory,
requests equal to limits, because Armada validates init containers exactly like main ones
(`internal/server/submit/validation/submit_request.go:255`) and may insist the CPU is
fractional (`:413`).

**How it is reached.** The pod declares the kernel port and the agent port, the submit
exposes every declared port through the one NodePort service (`exposedPorts` in
`src/podspec.ts`), and the executor reports one address per service port in the same
`JobIngressInfoEvent` decision 20 already read (`internal/executor/reporter/event.go:148`).
`ready()` waits for the pod, reads the agent's address, and polls its `/healthz` until it
answers (`src/sandbox.ts`, `src/channel.ts`). No cluster id, no kubeconfig: `ClusterAccess`
and `ARMADA_KUBECONFIG_PATTERN` are gone, and so is `@kubernetes/client-node` from the
bundle, which fell from megabytes to 40 KB.

**The protocol.** One request type, `POST /exec` with `{cmd, stdin?, timeoutMs?}`, and a
streaming NDJSON response: `{pid}`, then `{stdout}` and `{stderr}` chunks as base64, then
`{exit, timedOut}` (`agent/server.go`). Streaming rather than the design's request and
response for one reason: cancellation. When the request's context ends, because the caller
closed it or the deadline passed, the agent sends `SIGTERM` to the command's process group
and `SIGKILL` five seconds later. That is the thing a Kubernetes exec could never do
(decision 23 measured it), and it is what makes both `run` and `stream` one endpoint.
`stream` in `src/channel.ts` forwards stdout chunks as they come and aborts the request on
cancel; `run` collects everything and rejects on `timedOut` with the same message the old
channel used, so the sandbox above it did not change.

**The token.** The adapter mints 32 random bytes per sandbox and puts only their SHA-256
in the pod spec as `MH_AGENT_TOKEN_SHA256`; every request carries the token as a bearer
and the agent compares hashes in constant time. This departs from the design, which put
the token itself in the spec. The spec is not secret: `GetJobDetails` returns it with
`expandJobSpec` (`pkg/api/job.proto:47`), Lookout renders it, and an env var is inherited by
every process the agent starts, `os.environ` in a notebook included. The hash leaks nothing.

**PID 1.** The agent reaps orphaned zombies, by reading `/proc` for state `Z` with
itself as parent and waiting on those it did not start itself (`agent/reaper_linux.go`),
so a crashed detached kernel is collected rather than left looking alive. It forwards
`SIGTERM` to every process in the container and waits up to 25 seconds for them, inside
the 30-second grace period from decision 10. If the agent itself dies, the container ends
and Armada fails the job, which is the right outcome.

**What changed above the seam.** One thing. `processGroupCommand` no longer wraps the
command in `setsid --wait` (`src/shell.ts`). The agent starts every command as the leader
of a new session, so the shell's `$$` is already the group id, and a second `setsid`
moved the command out of the group the agent kills: the first live run showed a timed-out
loop surviving its kill for exactly that reason. The group file, the `onStop` kill and the
sweep (decisions 24 and 25) were kept for a while, redundant when the agent's kill landed
and still useful when it could not. Step 3 of the design's order of work has since deleted
them and added the process and file endpoints that retire the rest of the shell layer:
decision 29.

**Exposure.** The agent port is exposed exactly as the kernel port is. Over a NodePort
that is plaintext HTTP on the cluster network, guarded by the token; over an ingress it is
a public HTTPS hostname to a shell, guarded by the token and whatever the ingress adds.
The production answer is the per-job ingress annotations from decision 13 with an
allowlist for marimohub's egress address. Open question 6 asks how you want this.

**Operational.** `ARMADA_AGENT_IMAGE` is required configuration with no default, since no
image is published yet, and `ARMADA_AGENT_PORT` defaults to 8718. The image is built for
the worker nodes' architecture, not marimohub's, which on an Apple Silicon laptop means
arm64 for the node and amd64 for marimohub. CI vets, tests and builds the agent
(`.github/workflows/ci.yml`); its tests drive the real protocol against real processes.

### 29. The agent grows process and file requests, and the shell workarounds go

Step 3 of `AGENT-DESIGN.md`'s order of work, built. Decision 28 kept the whole
group-file-and-sweep apparatus (decisions 24 and 25) as belt and braces and left every
adapter operation as a shell command reached through `/exec`. Both were provisional, and
this decision retires them: the agent now answers what a shell answered badly, and the
things that only existed to repair the shell channel are deleted.

**Detached processes are the agent's own children.** `startProcess` is `POST
/process/start`, and `waitForPort`, `getLogs` and `kill` are `/process/{waitport,logs,signal}`
(`agent/process.go`, `src/channel.ts`). Because the agent forks the process itself, three
things that were shell workarounds become exact. Liveness and the exit code come from a
real `wait`, not from reading `/proc` state and guessing, so the `/proc` `Z` probe of
decision 19 is gone. `waitForPort` is one request the agent answers by dialling
`127.0.0.1` in-pod while watching the process, so the chunked wait, the per-chunk liveness
check and the inline `python3` connect loop of decision 19 are all gone, and a kernel that
dies is reported the instant it does rather than at a chunk boundary. The launch still
runs `sh -lc`, so profile-provided env reaches the kernel, and a crash is still worded
`process exited before port N opened` with the log appended.

One correction the first live run forced: `/process/signal` signals the **group**, the
negated pid, not the one process. The `sh -lc` wrapper the adapter launches can fork the
real command rather than exec it, so signalling only the leader left the kernel, and
anything a notebook spawned, orphaned and running in the pod. Every started process is a
session leader (the agent sets `Setsid`), so its pid is its group id, and a group signal
takes the whole tree. This closes by construction the orphan leak that decision 25's sweep
existed to chase after the fact.

**Files cross as bytes, not through a shell.** `writeFile`, `readFile` and `listFiles` are
`PUT /files`, `GET /files` and `GET /files/list` (`agent/files.go`). Content travels raw
in the request or response body and the path travels as a query parameter, so the base64
transport of decision 21, the `'\''` quoting of decision 22, the `mkdir -p && cat`
command, the wrapped-line rejoining and the `find -printf` parsing are all gone, along with
their assumptions on GNU `find` and coreutils `base64`. Every behaviour those commands were
carefully built to produce is preserved in `agent/files.go` and checked by its tests: the
encoding reported to marimohub is still chosen from the bytes, an absent path is still
`not_found` (dangling symlinks counted as present, per the old `[ -L ]`), listing a file is
still `not_a_directory` rather than an empty success, and a byte order mark still
round-trips. The hidden-file filter stays in the adapter (`toFileInfos` in `src/sandbox.ts`)
so a recursive listing still descends into dot directories and reports their non-dot
children, which is what `readSessionArtifacts` relies on.

**What was deleted.** `src/sweeper.ts` and its test, the `/tmp/mh-*.pgid` group files, the
`processGroupCommand`/`killGroupCommand`/`sweepGroupsCommand` builders and their parsers,
`ARMADA_GHOST_SWEEP_SECONDS`, and the `ghosts_killed` counter. The reasoning is that the
agent closed the one gap the sweep could not otherwise reach. The sweep's hardest case was
a marimohub restart, which abandoned every open exec websocket without stopping anything;
under the agent a restart is every request's context ending at once, and the agent kills
each command's group when its request ends, so there is nothing left to sweep. The design
rule the sweep defended, never kill by heuristic, is unchanged and now holds by
construction: the agent only ever kills the groups of requests it is serving, never a
process it merely found.

**The backstop moved into the deadline.** `ARMADA_COMMAND_MAX_SECONDS` (decision 25) is
kept, but it is no longer a mark the sweep acts on later. An `exec` with no caller timeout
is now sent to the agent with the backstop as its `timeoutMs`, so the agent enforces it the
same way it enforces a real timeout, and the adapter reports it with a message naming the
backstop rather than a timeout nobody set (`src/sandbox.ts`). Streams stay exempt, as
before. `0` still turns it off, which sends no deadline at all.

**Verified live** through `bun run smoke`: files written, read back byte for byte and
listed with their sizes, an absent path as `NOT_FOUND`, a detached server whose port the
agent waits for and whose `kill()` (a group signal) leaves nothing behind, a process that
dies at once reported as a crash with its log, and the timed-out exec and cancelled stream
leaving no strays, zombies included.

### 30. Ingress exposure is a submit-time choice, and a real controller carried a session

Step 4 of `AGENT-DESIGN.md`'s order of work, built and verified. Decision 20 left the
kernel URL at plain `http://` to a NodePort "until an Ingress config with TLS lands";
this is that landing, for the kernel port and the agent port alike.

**What the submit sends.** `ARMADA_EXPOSE` chooses one of two shapes per job
(`src/config.ts`, `src/armada.ts`). `nodeport`, the default, is decision 28 unchanged: a
`services` entry of type `NodePort` over both declared ports. `ingress` sends one
`ingress` entry instead, `{ports, tlsEnabled, certName?, useClusterIP: true, annotations?}`,
and no service. Armada creates the service itself: with no submitted service covering the
ingress ports it makes a ClusterIP one and the Ingress on top
(`internal/server/submit/conversion/conversions.go:151`, `:181`), one rule per port with
host `<container>-<port>-<pod>.<namespace>.` (`:263`) plus the executor's
`hostnameSuffix` (`internal/executor/job/submit.go:165`). `useClusterIP` is true because
Armada's default is headless (decision 13); ingress-nginx routes to endpoints and would
cope, a controller that routes through the service IP would not, and there is no reason to
find out per controller. With `tlsEnabled` the Ingress carries one TLS entry listing both
hostnames, whose `secretName` is `certName` or `<namespace>-` (`conversions.go:297`) with
the executor's `certNameSuffix` appended (`submit.go:170`). The executor ships with
`hostnameSuffix: svc` and `certNameSuffix: ingress-tls-certificate`
(`config/executor/config.yaml:64`), so an executor nobody configured yields
`kernel-2718-armada-<job>-0.default.svc`, a name that resolves nowhere, and
`default-ingress-tls-certificate`, a secret to create in the job's namespace.

**What the adapter reads.** Unchanged: the same `JobIngressInfoEvent`, one entry per port,
with the rule host where the NodePort address was (`internal/executor/reporter/event.go:162`;
when both a NodePort service and an Ingress exist the host wins, since that loop runs
second). `portUrl` adds the scheme, `https` when TLS is on, so the agent endpoint and
`exposePort` both carry a URL rather than a bare address. No hostname is templated
(decision 13).

**Three things Armada cannot set, so the deployment must.** The generated Ingress has no
`ingressClassName`: `conversions.go:312` copies rules and TLS only. The cluster therefore
needs a default IngressClass, a controller that serves class-less Ingresses (kind's
ingress-nginx manifest passes `--watch-ingress-without-class`), or the older
`kubernetes.io/ingress.class` annotation, which `ARMADA_INGRESS_ANNOTATIONS` or the
executor's `podDefaults.ingress.annotations` can carry. The hostname suffix must be a
wildcard DNS record for the controller's address, one level below the namespace. And the
certificate must be a wildcard for `*.<namespace>.<suffix>` in the secret the names above
produce, with marimohub trusting its issuer: `NODE_EXTRA_CA_CERTS` for a private CA, which
Node and Bun both honour.

**Websockets.** The one assumption decision 20 could not test is now verified. Through
ingress-nginx at its defaults, a 60-second `proxy-read-timeout` included, the editor's
websocket lived 234 seconds and closed only when the session was stopped, across a
110-second stretch with no interaction and no disconnect shown. Nothing needs setting for a
session to work; an operator who sees idle drops behind another controller has
`ARMADA_INGRESS_ANNOTATIONS` for its timeout.

**A public hostname to a shell.** Over an Ingress the agent port is reachable from wherever
the controller is, guarded by the token alone (decision 28). The per-job annotations are the
place for a source allowlist (`nginx.ingress.kubernetes.io/whitelist-source-range` on
ingress-nginx, marimohub's egress address as its value), the executor's cluster-wide
annotations are the other, and a private ingress class is the third answer. Choosing is
open question 6.

**Local.** `dev/ingress-local.sh` gives the kind cluster all three things: ingress-nginx
pinned to the worker node on its host ports 80 and 443, the executor's suffix patched to
`<worker-ip-with-dashes>.sslip.io` so every generated hostname resolves to that node with no
DNS of our own, and a self-signed wildcard certificate in the secret Armada's defaults
name, with its CA under `dev/tls/` for the smoke run and marimohub to trust. The two dev
scripts pass `ARMADA_EXPOSE` and the ingress variables through and mount that CA when it
exists.

**Verified live.** `bun run smoke` under `ARMADA_EXPOSE=ingress`: the agent answered at
`https://kernel-8718-armada-<job>-0.default.172-18-0-2.sslip.io` and every check passed,
the cancelled stream included, so nginx buffers nothing the protocol minds. A notebook
session from a real browser against marimohub in ingress mode: Armada created one ClusterIP
service and one Ingress with two host rules and one TLS entry naming
`default-ingress-tls-certificate`; the provision line reported reachable in 24.0s and
succeeded in 24.5s; the editor loaded through the proxy over the ingress and the kernel
reported healthy; and Stop removed the pod, the service and the Ingress together.

## Constraints on the first submit

Collected from `internal/server/submit/validation/submit_request.go` so the first real submit
is not a guessing game. A job is rejected unless:

- Exactly one pod. `podSpec` and `podSpecs` are mutually exclusive, and multiple pods are not
  supported (`:137`).
- `queue`, `jobSetId` and `namespace` are set (`:112`, `:129`, `:154`). `jobSetId` and
  `clientId` are length capped (`:120`, `:209`).
- Every container specifies resources, and **requests equal limits** unless the server allows
  oversubscription (`:249`, `docs/creating_and_submitting_jobs.md`). This applies to init
  containers too (`:255`), and a server can additionally insist that an init container's CPU
  is fractional, `100m` rather than `1` (`:413`, `AssertInitContainersRequestFractionalCpu`).
  The agent's install container in `AGENT-DESIGN.md` sets `100m` for that reason.
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

1. **Is exec-into-executor-pods acceptable in your deployment?** Answered on 2026-09-07:
   no. A central service holding cluster credentials bypasses Armada. The reviewer names
   exec in binoculars upstream as the best answer for security, and an Armada release away.
   The answer that ships first is an agent inside the pod, reached through a second port
   that Armada exposes and reports like the kernel's. The design is
   `AGENT-DESIGN.md`; the note at the head of decision 11 says what it changes here. The
   question as originally asked, kept for the record: we knew there was no Armada-native
   alternative, no API that forbids exec from outside, and that the per-cluster component
   pattern exists but exposes only logs and cordon. What we could not know was whether an
   operator would accept it. This was the one answer that could change the architecture,
   and it did.
2. **One queue or a queue per user?** Fair share is computed per queue with a per-queue
   priority factor (`docs/scheduling_and_preempting_jobs.md`), so queue granularity _is_ the
   fairness model for a multi-tenant notebook server. We currently take a single queue from
   configuration. Whether that is right depends on how you expect tenants to compete.
3. **Is a mostly-idle interactive job a reasonable citizen of an Armada cluster?** Fair share
   is computed from resource _requests_ of running jobs, so an idle kernel costs its full
   request all session. That is a capacity-planning question for whoever runs the cluster,
   not an API question.
4. **Is depending on Lookout acceptable in your deployment?** The server API cannot
   enumerate jobs, so `listActive` asks Lookout (decision 27), a UI component whose API is
   not offered as a stable public contract. If an operator says no, the answers in order of
   preference: drop the capability (the adapter already degrades to a no-op reconciler when
   `ARMADA_LOOKOUT_URL` is unset), add a list call to binoculars upstream, or wait for
   Armada to grow a first-class enumeration call. Also worth asking: is your Lookout meant
   to be called server-to-server at all, auth included?
5. **Is a churn of one-job job sets a reasonable footprint for the server and Lookout?**
   Every kernel session is its own job set (decision 4), created and cancelled continuously
   as users open and close notebooks, and `listActive` pages Lookout on every reconciliation
   sweep (decision 27). Nothing in the API surface suggests either minds, but event
   retention and storage per job set, and whatever Lookout does with a growing population of
   terminal one-job sets, are operational matters we cannot see from here. Is there a scale
   at which this shape becomes an anti-pattern, and is there server-side tuning (event
   retention, expiry) an operator should set for it?
6. **Where should the agent image live, and how should its port be exposed?** Decision 28
   exposes the agent port exactly as the kernel port, and decision 30 makes the ingress
   form real: `ARMADA_EXPOSE=ingress` gives both ports an HTTPS hostname, verified against
   ingress-nginx. The token guards the agent either way, but an ingress makes it a public
   hostname to a shell, and the sensible answers (a source allowlist per job through
   `ARMADA_INGRESS_ANNOTATIONS`, one cluster-wide in the executor's ingress annotations,
   or a private ingress class) are deployment choices, as is which controller and which
   default IngressClass, since Armada sets none. So is the registry the worker clusters
   pull the agent image from, and whether one image for both architectures is wanted.

## What has been verified

Verified:

- Every endpoint, definition, field and enum in `src/armada-types.ts` exists in Armada
  `v0.22.7` as we describe it, and the Lookout tokens in `scripts/check-armada-api.ts`
  exist in that release's Lookout swagger. Reproducible: `bun run check:armada-api`,
  currently 4 endpoints, 17 definitions, 71 fields, 12 lookout tokens.
- Every citation in this document was read in the Armada source at that release.
- The local environment works: armada-operator's kind quickstart, REST gateway on port 30001,
  jobs submittable with `armadactl`.
- marimohub 0.3.12 loads this adapter in library mode, and a missing environment variable
  fails startup with our own error message.
- Before decision 28, exec into an executor-created pod worked in practice, from the host
  and from inside the marimohub container through a mounted kubeconfig. Kept for the
  record; that channel no longer exists.
- The agent (decisions 28 and 29) against the real cluster, through `bun run smoke` from a
  container on the `kind` network: Armada accepts the pod with two ports, an init
  container and a volume; the address event carries an address for each port; the pod
  runs the agent as PID 1 from the volume the init container filled; a command runs
  through it at the address Armada reported; a file is written, read back byte for byte
  and listed with its size, and an absent path is `NOT_FOUND`; a detached server's port
  is waited for and its `kill()` (a group signal) leaves nothing behind; a process that
  dies at once is reported as a crash with its log; and a timed-out loop and a cancelled
  stream are dead afterwards, the stray check finding nothing, zombies included.
- A full notebook session through the agent, from a real browser against marimohub in its
  container with no Kubernetes credential mounted: the provision line reports reachable
  in 12.0s, files, `uv sync`, kernel start, port wait and expose all succeeding
  (`sandbox_provision_succeeded: true`), the marimo editor loads through the proxy,
  reports a healthy runtime and autosaves, and Stop cancels the job.
- `writeFiles` and `setEnvVars` round-trip against a real pod: a filename containing a
  quote and spaces, binary bytes read back exactly, a relative path landing in the
  container's working directory without a stray directory, forced-beats-default precedence,
  and a pre-existing `HOME` surviving an `onlyIfUnset` attempt.
- `startProcess` against a real pod: a detached `http.server` stays up after the launch
  returns, `waitForPort` sees its port, sandbox and per-process env reach it, `getLogs`
  reads its output, `kill` really terminates it and leaves no orphaned child (the signal
  goes to the group), and a command that exits at once is reported as a crash carrying its
  log, not as a timeout. Since decision 29 the agent parents the process, so liveness and
  the crash come from a real `wait`, not the `/proc` probe the shell channel needed.
- `exposePort` against a real pod: the URL comes back as `http://<node-ip>:<nodePort>` in
  single-digit milliseconds (the ingress event replays from the stream), and an HTTP
  request through that NodePort reaches a server listening on the kernel port.
- `readFile` and `listFiles` (since decision 29, the agent's `/files` endpoints) against
  the unit suite and a real pod: text decoded and reported as `utf-8`, binary bytes
  returned as base64 that decodes to the exact bytes, a byte order mark preserved, an empty
  file as an empty success, a path with a quote and spaces crossing intact, an absent path
  as `NOT_FOUND` and a directory as `READ_FAILED`; a flat listing that hides dotfiles and
  does not descend, a recursive one that descends into a dot directory and reports its
  non-dot children, a file listed as `NOT_A_DIRECTORY`, and an absent directory as
  `LIST_FAILED`. The agent's own Go tests cover the same probe order on the pod side.
- `execStream` against a real pod: stdout chunks arrive as produced rather than at the end,
  sandbox env and a login shell reach the command, stderr stays out of the stream, a
  timeout truncates an endless command instead of failing it, and cancelling stops the
  command in the pod (the agent kills its process group when the request drops).
- `gitCheckout` against a real pod: a public repo cloned with a branch and target
  directory, the cloned README read back through `readFile` and the checked-out branch
  confirmed in-pod, and a nonexistent repo surfacing as a thrown
  `git checkout failed: fatal: ...`. The local kernel image ships git 2.47.3.
- Abandoned commands leave nothing behind (decision 29's smoke run): a timed-out `exec` and
  a cancelled stream are both dead afterwards, and the stray listing over `/proc` finds no
  live process and no zombie, because the agent kills each command's group when its request
  ends and reaps orphans as PID 1. The agent's Go tests cover the kill on deadline, on
  caller disconnect, and its reach into a forked child.
- `listActive` against stubbed Lookout responses: the request body (queue and annotation
  filters, the four active states, ordering, page size), pagination until a page comes back
  short, `jobSet` mapping with `createdAt` only when `submitted` is present, the missing
  `ARMADA_LOOKOUT_URL` rejection, and the provider advertising the capability only when
  Lookout is configured.
- A whole notebook session end to end, from a real browser against the local cluster:
  opening a notebook provisions a pod (12.1s total, 11.1s of it placement), the marimo
  editor loads through marimohub's `/proxy/<token>/` route, the kernel executes the
  notebook's cells, autosave writes back to `/workspace/notebook.py` over the proxied
  websocket, and the kernel's `/api/status` through the proxy reports healthy.
- Ingress exposure (decision 30) against ingress-nginx on the local cluster: the submit
  with an `ingress` entry and no service is accepted, Armada creates a ClusterIP service and
  one Ingress with a host rule per port and a TLS entry naming the default secret, the
  address event carries the two hostnames, `bun run smoke` passes in full over HTTPS
  through the controller, a browser session provisions (24.5s), loads the editor and runs
  a healthy kernel through it, the websocket outlives the controller's default 60-second
  read timeout by minutes of idle time, and Stop removes the pod, service and Ingress.
- Build, type checks, tests and image build pass in CI.

Assumed, not verified:

- That the kernel image provides `/bin/sh` and `git`. Verified only against the local
  `marimo-sandbox:local` image, which is Debian-family; see decision 22. Since decision 29
  these are the only two: the file and process endpoints moved off `find`, `base64`,
  `setsid` and the `python3` waiter, so a kernel image no longer needs any of those.
- That an interactive session survives normal scheduling behaviour once decisions 7 to 9 are
  applied.
- That an ingress controller other than ingress-nginx behaves the same (decision 30):
  serving a class-less Ingress, carrying the websocket, routing to a ClusterIP service.
- That `listActive` answers against a real Lookout. The tests stub its responses; the local
  cluster's Lookout on port 30000 has not been asked yet.
- The four items under [Still open](#still-open).

## Where to look in the code

| Path                           | What it is                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `src/types.ts`                 | marimohub's adapter interface, transcribed by hand. Not ours to change.                         |
| `src/armada.ts`                | Placement: submit, watch, ingress address, cancel; `listActive` via Lookout.                    |
| `src/channel.ts`               | Control channel: the client for the agent's exec, process and file endpoints.                   |
| `agent/`                       | The agent itself: a Go program run as PID 1, with the exec, process and file endpoints.         |
| `AGENT-DESIGN.md`              | The reviewer's design for the in-pod agent; decisions 28 and 29 are what was built from it.     |
| `src/shell.ts`                 | Env prefix, quoting and the clone command that `exec` still needs, from `compute-commons`.      |
| `src/sandbox.ts`               | One kernel session: `exec` on the agent, everything else on its typed endpoints.                |
| `dev/smoke.sh`, `dev/smoke.ts` | The live check, run from a container on the `kind` network so it can reach the agent.           |
| `dev/ingress-local.sh`         | Ingress-nginx, a wildcard hostname suffix and a certificate for the kind cluster (decision 30). |
| `src/armada-types.ts`          | Hand-written Armada wire types, with the reasoning in the header.                               |
| `scripts/check-armada-api.ts`  | The contract check that keeps those types honest.                                               |
| `README.md`                    | Configuration and deployment; `docs/ARCHITECTURE.md` and `docs/CONTRIBUTING.md` for the rest.   |

One path is deliberately absent from the table: marimohub itself, cloned from the URL in the
introduction. Its provisioner, reconciler, compute contract and kubernetes adapter
are the other half of most claims above, and `src/types.ts` and `src/shell.ts` are
transcriptions of its code. Questions about that half are best answered in that checkout,
with an agent doing the reading (see the introduction).
