# Armada adapter: decisions for review

This document records every design decision behind `marimohub-compute-armada`, the evidence
for it, and what is still a judgement call. It is meant to be read by someone who knows
Armada and does not know this repo.

The adapter partially works. The whole provision sequence is implemented and verified
against a real local Armada: placement (submit, wait for running, cancel), exec into the
placed pod, file writes, env vars, detached process launch, the exposed-port URL from
Armada's ingress event, reading files and directories back out, streaming a command's
output, and cloning a repository. The one remaining stub that throws is `listActive` on
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

### 21. Read files back as base64, and let the bytes choose the encoding

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
busybox lacks: `find -printf` (decision 21), `setsid` and its `--wait` flag (decisions 19
and 23). `base64` (decision 21) exists in both coreutils and busybox, and `python3`
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
- `readFile` and `listFiles` against a real pod: text read back byte for byte (including
  a non-ASCII character), binary content returned as base64 that decodes to the exact
  bytes written, a 500-byte file whose wrapped base64 rejoins, an empty file as an empty
  success, a quoted path, an absent path as `NOT_FOUND` and a directory as `READ_FAILED`;
  a flat listing that hides dotfiles and does not descend, a recursive one that reaches
  `__marimo__/session/notebook.py.json` and shows `.env`, a file listed as
  `NOT_A_DIRECTORY`, an absent directory as `LIST_FAILED`, and a read that is unchanged
  after `setEnvVars`.
- `execStream` against a real pod: three chunks a second apart arrive at 40ms, 1042ms and
  2044ms rather than together at the end, sandbox env and a login shell reach the command,
  stderr stays out of the stream, a timeout truncates an endless command instead of failing
  it, and cancelling stops the command in the pod (measured by a loop that keeps ticking
  into a file: it stops on cancel and on timeout, and it did _not_ before the process-group
  kill was added).
- The timeout kill (decision 24) against a real pod: a command with a deadline keeps its
  stdout, stderr and exit status through the `setsid` wrapper, a timed-out loop is dead
  three seconds later rather than still ticking, no group files are left behind, and the
  ghost check reports an empty pod.
- `gitCheckout` against a real pod: a public repo cloned with a branch and target
  directory, the cloned README read back through `readFile` and the checked-out branch
  confirmed in-pod, and a nonexistent repo surfacing as a thrown
  `git checkout failed: fatal: ...`. The local kernel image ships git 2.47.3.
- The sweep (decision 25) against a real pod, through `bun run smoke`: a timed-out command
  and a cancelled stream leave nothing behind, a deliberately planted group that nothing is
  waiting on is killed by the sweep and reported (`killed 1 abandoned process group(s)`),
  and the stray listing afterwards shows only zombies, no live process.
- Build, type checks, tests and image build pass in CI.

Assumed, not verified:

- That exec works from inside the marimohub container rather than from the host; the kind
  API server certificate makes that route non-obvious (see README).
- That the kernel image provides `/bin/sh`, GNU `find`, `git` and `setsid` with `--wait`. Verified
  only against the local `marimo-sandbox:local` image, which is Debian-family; see decision 22.
- That an interactive session survives normal scheduling behaviour once decisions 7 to 9 are
  applied.
- That the generated Ingress carries WebSocket traffic with a real ingress controller.
- The three items under [Still open](#still-open).

## Where to look in the code

| Path                          | What it is                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `src/types.ts`                | marimohub's adapter interface, transcribed by hand. Not ours to change.                  |
| `src/armada.ts`               | Placement: submit, watch, ingress address, cancel. `listActive` stubbed.                 |
| `src/exec.ts`                 | Control channel: exec into a located pod, buffered or streamed.                          |
| `src/shell.ts`                | Quoting, env prefix, port waiter, read, list and clone commands, from `compute-commons`. |
| `src/sweeper.ts`              | The provider's one ghost sweeper: registration, cap, timer.                              |
| `src/sandbox.ts`              | One kernel session. Everything below `exec` is ordinary shell commands.                  |
| `src/armada-types.ts`         | Hand-written Armada wire types, with the reasoning in the header.                        |
| `scripts/check-armada-api.ts` | The contract check that keeps those types honest.                                        |
| `README.md`                   | How to run the whole thing locally, and what failure looks like today.                   |
