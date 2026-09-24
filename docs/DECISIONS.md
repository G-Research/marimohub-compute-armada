# Design decisions

Why the adapter is shaped the way it is. [ARCHITECTURE.md](ARCHITECTURE.md) is the map;
this is the reasoning, with the evidence each choice rests on. Citations of the form
`internal/...` or `pkg/...` point into the Armada source at the release named in
`.armada-version`, and citations of the form `packages/...` point into
[marimohub](https://github.com/marimo-team/marimohub) at the release the adapter interface
is transcribed from (see `src/types.ts`).

Both the adapter and this text were written with heavy AI assistance, and the Armada claims
were gathered by reading the pinned release rather than from operating experience. A wrong
citation is a bug: please report it.

## Talking to Armada

**The REST gateway, not gRPC.** Armada ships clients for Go, Java, Scala, Python and .NET,
not JavaScript. Every RPC carries a `google.api.http` annotation, so it has an HTTP form.
Generating a gRPC client would drag a protobuf runtime into a bundle that has to stay small,
for four calls. The consequence is that the job-set event stream arrives as
`application/ndjson-stream`, one JSON object per line (`{"result": ...}` or
`{"error": ...}`), which `src/ndjson.ts` parses. Stream semantics, from
`internal/server/event/event.go:85`: `watch: true` keeps the stream open with the server
long-polling in 5s slices, `watch: false` ends it at the last existing message,
`errorIfMissing: true` returns 404 for a job set that does not exist yet, and
`fromMessageId` is the resume cursor. A consumer that returns from the middle of a watched
stream must cancel the body, or the socket stays open until the server gives up.

**Hand-written wire types, checked against the spec.** The four endpoints the adapter calls
reach 202 of the spec's 249 definitions, 165 of them embedded Kubernetes types already
available from `@kubernetes/client-node`, so generating would mean re-reviewing thousands of
lines per Armada release. Generated zod schemas were measured at 0.71 MB bundled for a single
schema, against a 40 KB adapter. `scripts/check-armada-api.ts` fetches the spec at the pinned
release and asserts every field and enum the adapter reads still exists with the type it is
read as. [CONTRIBUTING.md](CONTRIBUTING.md) says how to keep it honest.

**The Armada version is pinned, and the local cluster does not honour it.** The
armada-operator quickstart runs `gresearch/armada-*:latest` for everything. Those images
serve the same spec as the pinned release today, and that will drift silently.

**Two auth mechanisms, or none.** Armada accepts basic, OIDC in several flows, Kubernetes
native and exec-based credentials (`pkg/client/connection.go:39`), but on the wire they are
one `Authorization` header. The adapter sends `Basic <base64(user:pass)>`, matching Armada's
own client (`pkg/client/auth/basic/credentials.go:13`), or a bearer token, static or re-read
from a file on every request so a rotated OIDC token needs no refresh flow and no restart.
The server compares the scheme case-insensitively for both (`internal/common/auth/basic.go:24`,
`oidc.go:43`). Kubernetes-native auth is deliberately not implemented: its bespoke
`KubernetesAuth <base64>` scheme carries a CA with the token
(`internal/common/auth/kubernetes.go:77`) and exists for executors, not API clients. Sending
nothing is a supported choice, since the quickstart runs `anonymousAuth: true`.

**Configuration is validated at startup.** A library adapter is constructed during
marimohub's boot, so a bad `ARMADA_URL`, two auth mechanisms at once, half a basic credential,
an unreadable token file, an ingress setting beside a NodePort exposure, or a queue map
without Lookout stops the server with a message naming the variable, rather than failing at
the first session.

## One job per kernel session

**Every id is the sandbox id.** `jobSetId` gives the session its own event stream
(`/v1/job-set/{queue}/{id}`) at no scheduling cost. `clientId` makes a retried provision
return the original job instead of a second kernel, because Armada discards a submission
whose `clientId` matches an existing job in that queue
(`internal/server/submit/deduplicaton.go`). `externalJobUri` is the only lookup keyed by
something the client chooses (`GetJobStatusUsingExternalJobUri`, `pkg/api/job.proto:92`);
`/v1/job/details` and `/v1/job/status` take explicit job ids and `/v1/queues/active` returns
queue names, so there is no "list the jobs I own" call in the server API. Enumeration is
Lookout's job, below.

**Submission is lazy.** marimohub's `create(id, options)` is synchronous, so the job is
submitted on first use, in the optional `ready()` method that marimohub awaits.

**A reached sandbox is remembered by the provider.** marimohub keeps no instance: every
call after provisioning, each periodic snapshot, the teardown and a surface's readiness
check among them, starts from a fresh `create(id)`. Each of those used to resubmit the job
(deduped by Armada), wait for its running event, look up the agent's address and poll the
agent before doing its work. The provider now keeps the job, pod and agent channel of every
sandbox this process has reached, and a fresh instance adopts them after a single look at
the agent's health; a pod that no longer answers is dropped and resolved from the start, and
`destroy` forgets it. This is per process by nature: after a restart the first call pays the
full resolution once, which is why the agent token has to be derived rather than kept.

**`activeDeadlineSeconds` is always set.** Armada assigns a default deadline to any pod
that does not set one, and the shipped default is 72 hours, 336 for GPU jobs
(`config/server/config.yaml:65`, `:67`). A kernel that inherits an operator's default is
killed mid-session with no signal the adapter controls, so it always sets one, from
marimohub's `sessionMaxLifetimeSeconds` when present and a configured default otherwise.

**Retries are off, with `failFast`.** A retried job keeps its job id, gets a new run and
reuses the same pod name, possibly on another cluster (`docs/retry_policies.md`). For a
kernel that is a fresh, empty process pretending to be the user's session. The
`armadaproject.io/failFast` annotation makes a failure terminal, and marimohub, which knows
what the session was, compensates and offers the retry. `JobFailedEvent.retryable`
(`pkg/api/event.proto:121`) is modelled to tell the two apart.

**The priority class is an override, not a requirement.** The shipped default,
`armada-default`, is already `preemptible: false`; `armada-preemptible` is the opt-in
(`config/scheduler/config.yaml:89`). `preemptible` means fair-share preemption; any job can
still be preempted by urgency if a higher class exists, so no class is absolutely safe. A
configured value must appear in the server's `allowedPriorityClassNames`
(`config/server/config.yaml:29`), which the client cannot check.

**The termination grace period is set explicitly.** Armada rewrites 0s to its configured
minimum and rejects anything above its maximum, shipped as 1s and 5m
(`config/server/config.yaml:63`). The adapter picks 30s, so a preempted or cancelled kernel
can flush, and the agent forwards `SIGTERM` and waits 25s inside that.

**What the server rejects at submit**, from `internal/server/submit/validation/submit_request.go`:

- More than one pod (`:137`); a missing `queue`, `jobSetId` or `namespace` (`:112`, `:129`,
  `:154`); an over-long `jobSetId` or `clientId` (`:120`, `:209`).
- A container without resources, or requests that differ from limits unless the server
  allows oversubscription (`:249`). This applies to init containers (`:255`), and a server
  may insist an init container's CPU is fractional (`:413`), which is why the agent's install
  container asks for `100m` and never `1`.
- `preferredDuringSchedulingIgnoredDuringExecution` node affinity (`:182`), a grace period
  outside the bounds (`:390`), a priority class not on the allowed list (`:230`), restricted
  tolerations (`:436`), duplicate container ports (`:162`).
- An ingress config with no ports, or a port in two ingress configs (`:87`). A port is only
  exposed if the pod declares it as a `containerPort` (`conversions.go:79`).

GPU needs nothing Armada-specific: an ordinary `nvidia.com/gpu` request, and the server adds
the toleration itself (`config/server/config.yaml:55`).

## Reaching the pod

**An agent in the pod, not a Kubernetes credential.** Armada's API is submit, cancel,
preempt, reprioritize, query and logs (`pkg/api/submit.proto`, `job.proto`,
`event.proto`), and its per-cluster component, binoculars, exposes exactly `Logs` and
`Cordon` (`pkg/api/binoculars/binoculars.proto:36`). There is no exec. The first version of
this adapter reached the pod through the Kubernetes exec subresource with a kubeconfig per
cluster, mirroring how Lookout reaches binoculars. Review by an Armada maintainer rejected
it: a central service holding a credential for every worker cluster bypasses Armada and has
direct power over every cluster, which is what Armada exists to prevent. The replacement
follows three rules: marimohub may talk to the Armada API; it may connect to an address
Armada reported in an event; it holds no Kubernetes credential of any shape. Under those
rules the pod must offer its own way to run commands, on a port Armada exposes next to the
kernel's, which is the agent in [ARCHITECTURE.md](ARCHITECTURE.md#the-agent).

**Alternatives considered.** Command execution in binoculars upstream would keep marimohub
talking only to Armada components, and is the best answer for security; it is an Armada
feature with its own release, and the adapter above the control channel is the same either
way, so the agent does not block it. The agent could connect out to marimohub instead of
being connected to, the only shape where nothing connects into a pod; marimohub has no place
to accept that connection today. marimohub could run inside one worker cluster with that
cluster's credential; that is still a Kubernetes credential, and works for one cluster only.

**The agent runs in the kernel container, from a volume.** It must share the kernel image's
filesystem, `PATH`, `uv` and `sh`, so it cannot be a sidecar. An init container from the
agent's own `FROM scratch` image runs `/agent install` into an `emptyDir` mounted at
`/mh-agent`, not `/shared`, because a notebook may reasonably create `/shared`. The
operator's kernel image is used unchanged. If a deployment forbids the shared volume, the
fallback is one `COPY` line in the kernel image.

**The pod carries a hash of the token, never the token.** The pod spec is not secret:
`GetJobDetails` returns it with `expandJobSpec` (`pkg/api/job.proto:47`), Lookout renders
it, and an env var is inherited by every process the agent starts, `os.environ` in a
notebook included. The adapter puts the token's SHA-256 in the spec, and the agent compares
hashes in constant time.

**The token is derived from the sandbox id, not minted.** It is
`HMAC-SHA256(ARMADA_AGENT_TOKEN_SECRET, sandboxId)`. marimohub keeps no sandbox instance
between calls: teardown (`packages/core/src/services/runtime/SessionRetirer.ts:220`), the
snapshot sweep (`sessionLifecycle.ts:190`) and every other path after provisioning call
`create(id)` again, possibly in another process or after a restart. A token minted at
random per instance was therefore known to the provisioning instance alone. Every later
instance resubmitted with a token of its own; Armada deduped the submit to the running job
on `clientId`, and the pod refused the new token with 401. So no session was ever captured:
each teardown read nothing back and then destroyed the pod. A cache of tokens in the provider
would have fixed only the case where marimohub had not restarted in between, which is how
the first case was found. The cost is one required secret that every marimohub process
shares. Whoever holds it can compute the token of any sandbox of that installation, where
before a leak exposed a single pod, and changing it cuts every running sandbox off from its
agent. It is a variable of its own rather than marimohub's `MARIMOHUB_AUTH_SESSION_SECRET`,
which the adapter could read, so that rotating user sessions never strands running kernels.

**Never kill by heuristic.** A kernel pod legitimately holds the kernel and whatever the
notebook spawned: a `subprocess.Popen`, a training run, a dev server. None is distinguishable
from a leak by looking at it, and any rule by age, CPU or parent eventually kills a user's
work, which is worse than the leak. So the agent only ever signals the process groups of
requests it is serving: a command dies when its request ends, and a marimohub restart is
every request ending at once. This replaced an earlier sweep that tracked abandoned process
groups in files; the agent closed the gap that sweep existed for.

**Exact where the reference is approximate.** marimohub's own adapters wait for a port with a
TCP connect and probe readiness with a `python3 urllib` one-liner. The agent parents the
process, so liveness and exit code come from a real `wait`, and `/process/waitport` takes
`{mode, path}`: `http` means any response to a GET of the path, redirects and 404s included,
each probe bounded to 2s, which is what a surface's readiness means
(`packages/core/src/services/runtime/surfaces/SurfaceManager.ts:78`). `/process/signal`
signals the group, not the leader, because the `sh -lc` wrapper may fork the real command
rather than exec it.

**What the kernel image must provide: `/bin/sh` and `git`.** `sh` is the dependency of
`exec`, `execStream`, `startProcess` and `gitCheckout`, the same shape marimohub's own
Kubernetes adapter uses (`packages/compute-kubernetes/src/index.ts:122`), and POSIX
requires it. `git` is a whole package `python:*-slim` does not ship. The adapter probes for
neither: a wrong assumption surfaces as that command's own failure, which is immediate rather
than mysterious. If a probe ever becomes necessary, inline it into the command that needs it
(`command -v` inside the same `sh -c`), and memoize only what has to reach JavaScript, per
sandbox rather than module-globally, since two sandboxes may run different images.

## Exposure

**Armada names the hostname; the adapter reads it.** An Ingress is generated from a ClusterIP
service, one rule per port (`internal/server/submit/conversion/conversions.go:246`), with
host `<container>-<port>-armada-<jobId>-0.<namespace>.` plus the executor's
`hostnameSuffix` (`internal/executor/job/submit.go:165`). The adapter never templates that,
so marimohub's `options.hostname` is ignored; the address comes from `JobIngressInfoEvent`,
one entry per exposed port, `hostIP:nodePort` for a NodePort service and the rule host for
an Ingress (`internal/executor/reporter/event.go:138`), the host winning when both exist.
`useClusterIP` defaults to false, which produces a headless service (`conversions.go:220`),
so the adapter sets it true: ingress-nginx routes to endpoints and would cope, a controller
that routes through the service IP would not. Per-job annotations are merged onto the
Ingress on top of the executor's (`conversions.go:308`). `IngressType` has exactly one
member, `Ingress` (`pkg/api/submit.proto:50`); the `NodePort` example under `ingress:` in
`docs/creating_and_submitting_jobs.md` is stale.

**Three things Armada cannot set.** The generated Ingress names no class (`conversions.go:312`
copies rules and TLS only), so the cluster needs a default IngressClass, a controller that
serves class-less Ingresses, or the `kubernetes.io/ingress.class` annotation. The hostname
suffix must be a wildcard DNS record for the controller. The certificate must be a wildcard
for `*.<namespace>.<suffix>` in the secret named by `certName` or `<namespace>-`
(`conversions.go:297`) plus the executor's `certNameSuffix` (`submit.go:170`). The executor
ships with `hostnameSuffix: svc` and `certNameSuffix: ingress-tls-certificate`
(`config/executor/config.yaml:64`), so an unconfigured executor yields a name that resolves
nowhere.

**The agent over an ingress is a public hostname to a shell**, guarded by the token alone.
A source allowlist for marimohub's egress address belongs in the per-job annotations
(`nginx.ingress.kubernetes.io/whitelist-source-range` on ingress-nginx), in the executor's
cluster-wide ingress annotations, or in a private ingress class. Which one is a deployment
choice.

**Websockets need nothing set.** Through ingress-nginx at its defaults, a 60-second
`proxy-read-timeout` included, an editor websocket lived for the whole session across
minutes of idle time. A controller that does drop idle connections has
`ARMADA_INGRESS_ANNOTATIONS` for its timeout.

## Sandbox semantics, transcribed from marimohub

marimohub's `packages/compute-kubernetes` and `packages/compute-commons` are the reference
for every sandbox operation, and its compute contract tests
(`packages/core/src/testing/computeContract.ts`) are the behavioural authority. Semantics
are transcribed, never invented; each deliberate divergence is listed here.

**Commands that run someone else's code get a login shell.** `exec`, `startProcess` and
`gitCheckout` run `sh -lc`, so an image that puts `uv` or `python3` on `PATH` through a
profile script keeps working. Profile output landing in `stdout` is the accepted cost, as it
is upstream. Nothing the adapter parses goes through a shell any more: files and process
state travel over the agent's typed endpoints.

**Environment variables are replayed as a prefix.** A running pod's environment cannot be
changed, so `setEnvVars` stores vars in memory and prepends `export K='v'; ` to every later
command. `onlyIfUnset` vars are exported behind a `[ -n "${K:-}" ]` guard placed after the
forced exports, which gives the precedence the contract requires: forced beats default, and
a value the image defines beats `onlyIfUnset`. Divergence: a name `sh` could not export is
rejected at `setEnvVars` with a clear error rather than surfacing as shell noise later. Vars
set before a marimohub restart are not replayed to a reattached pod; upstream has the same
property, and the provisioner sets env immediately before starting the kernel.

**The bytes choose the encoding `readFile` reports.** `ReadFileResult` carries an optional
`encoding` of `utf-8` or `base64`, and marimohub's two consumers disagree:
`readSessionArtifacts` (`packages/core/src/services/runtime/sandboxFiles.ts:352`) takes
`content` and never looks at `encoding`, while `proposalCapture`
(`packages/core/src/services/content/proposalCapture.ts:201`) decodes by it. Reporting base64
unconditionally would store base64 as notebook source; reporting UTF-8 unconditionally would
corrupt an image. So valid UTF-8 is returned as text and anything else as base64. A byte
order mark is preserved. Divergences: an absent path is `NOT_FOUND` rather than upstream's
blanket `READ_FAILED`, because session capture reads four fixed paths of which several
routinely do not exist; a dangling symlink counts as present; a bare relative filename
creates no spurious parent directory (upstream's `lastIndexOf` fallback does).

**Bounded reads are refused in the agent, not by a Python trampoline.** From `main` f4e5ef8
(2026-09-23, in no release as of v0.4.10), marimohub captures a session only through the
optional `readFileBounded`; an adapter without it gets one warning and no capture at all,
periodic snapshot and teardown alike (`supportsBoundedReads`,
`packages/core/src/services/runtime/sandboxFiles.ts:37`). The first-party adapters share a
reader that has only `exec` to work with, so it ships a `python3 -I -c` script that walks
the path (`packages/compute-commons/src/boundedRead.ts`). The agent has a file API of its
own, so `GET /files/bounded` does the same walk in Go (`agent/files_linux.go`): every
component opened with `openat` relative to the last, `O_NOFOLLOW` so a symlink anywhere
fails, `O_DIRECTORY` on all but the last, and `O_NONBLOCK` so a FIFO cannot hang the open.
`fstat` on the opened file rejects anything not regular or over `maxBytes`, and the read
takes `maxBytes + 1` bytes so a file that grew in between fails too. The deadline is the
agent's: the read runs aside and the request is answered when `timeoutMs` passes, even
while a syscall blocks. A read stuck that way keeps one of 64 slots until it ends, so a hung
network filesystem cannot pile up goroutines and descriptors; past that the agent refuses
new bounded reads until one finishes. The kernel image needs no Python for any of it. It is a route of
its own rather than parameters on `GET /files` so that an agent image older than the
adapter answers 404, which the channel reports as `BACKEND_ERROR`, instead of an unbounded
read that follows symlinks. Upgrading marimohub past v0.4.10 therefore means rebuilding
the agent image along with the bundle. The adapter validates the budget before anything
else, as upstream's contract test requires (`computeContract.ts:233`), holds the body to
`maxBytes` itself, and abandons the request a second after the deadline, so that the
agent's own "deadline passed" is what gets reported rather than a bare abort. Divergences: an absent path
is `NOT_FOUND` rather than `READ_FAILED`, for the reason `readFile` gives above; the
deadline covers the read, not reaching a pod this process has not reached yet, which every
call does first; and the Linux build alone can open this way, since Go's `syscall` package
has no `openat` elsewhere, so on other systems the agent refuses and its tests skip.

**`readFileBounded` always reports base64.** The hazard that makes `readFile` choose
by the bytes does not apply: the bounded read's one consumer, `readBoundedBytes`
(`sandboxFiles.ts:456`), decodes by `encoding` and then checks the decoded size against the
budget. base64 is right for every file, which a guess from the bytes is not, and it is what
the reference reader answers. An `encoding` that did not match the content would make that
check drop the file without a word, which is the data loss the method exists to prevent.

**A failed read is logged, the one line the adapter writes.** Everywhere else the adapter
reports through thrown errors and typed results and prints nothing. A read that fails is
the exception, because marimohub drops that failure without a trace: `readSessionArtifacts`
leaves out what it cannot read, `commitSession` then has no code and returns `null`
(`packages/core/src/services/content/NotebookService.ts:833`), capture counts that as
success, and teardown destroys the pod. An agent unreachable at stop time costs the whole
session's edits and leaves the same state behind as a notebook nobody touched. This line
is how the per-instance agent token was found (see "The token is derived from the sandbox
id" above): every capture had been failing with 401. So `readFile` and `readFileBounded`
write one `console.warn` per `READ_FAILED` or `BACKEND_ERROR`, naming the sandbox, the path, the code and the reason,
which is how marimohub's own core reports skipped files throughout `sandboxFiles.ts`.
`NOT_FOUND` stays quiet, since session capture reads four fixed paths of which several
routinely do not exist and a warning there would fire on every healthy session. The
agent's token is masked in the line, in case a transport error ever quotes a header.

**Listing a file is `NOT_A_DIRECTORY`**, never an empty success
(`computeContract.ts:260`). `includeHidden` filters on an entry's own name, so a recursive
listing still descends into a dot directory and reports its non-dot children, which
`readSessionArtifacts` relies on for `__marimo__` trees.

**`execStream` really streams.** marimohub's Kubernetes adapter buffers and emits one chunk;
the semantics here are transcribed from its local backend
(`packages/compute-local/src/index.ts:381`), the one adapter that streams a real process.
The stream carries stdout only, since it has no framing; stderr is drained so a full pipe
never blocks the command. Cancelling kills the process group. The exit code is unreachable,
so a failing command is a stream that ends. One deliberate difference from `exec`: a timeout
ends the stream rather than failing it, because bytes have already been delivered. Nothing in
marimohub calls `execStream` today; it is in the required surface
(`packages/core/src/ports/adapterShape.ts:19`), and the buffered version would be a trap for
whoever adds the first consumer.

**`gitCheckout` is upstream's quoted one-liner through the ordinary `exec`**, so a `git` a
profile put on `PATH` is found, a credential helper reading a token set through
`setEnvVars` works, and a clone abandoned mid-transfer is killed with its request.

**No bucket mounting.** `supportsBucketMount = false` and `mountBucket` throws, which is
marimohub's documented way to fall back to copying files in.

**The command backstop is not a timeout.** Only one of marimohub's `exec` call sites passes
a timeout; the rest legitimately take minutes. `ARMADA_COMMAND_MAX_SECONDS` (default six
hours) is far past anything expected, and exists so a command nobody is waiting on any more
cannot hold a process for the rest of the session. Streams are exempt, since how long one
stays open is its reader's decision.

**Surface ports come from marimohub's own settings.** `MARIMOHUB_SURFACES` and
`MARIMOHUB_SURFACE_<ID>_PORT` are read the way marimohub reads them
(`packages/config/src/surfaces.ts`), because `multiPort` must be advertised exactly when the
ports marimohub will ask for are on every pod, and a variable of the adapter's own could
disagree. A surface port must not be the agent's, and an unknown surface id is refused at
startup since it can only mean a newer marimohub. Left alone on purpose: `resolveProcessPath`,
because a pod's processes see the paths marimohub writes; and `sessionIdleTimeoutMs`, which
only the Modal adapter uses, since `activeDeadlineSeconds` already bounds a session.

**The kernel image defaults to marimo's published one.** `MARIMOHUB_COMPUTE_IMAGE` unset
means `ghcr.io/marimo-team/marimo-sandbox:latest`, the image marimohub's own docs point the
variable at and the one built to its sandbox contract. marimohub's kubernetes adapter also
defaults when the variable is unset, though to `ghcr.io/marimo-team/marimo:latest`, the
bare marimo image; that one is not documented against the hub's contract, and the sandbox
image is what every hub example names, so the divergence is in the value only. A set but
empty variable is still refused: that is a mistake, not a request for the default.

**Shipped as a bundle baked into the marimohub image.** One `COPY` onto the stock image, with
the library-mode variables preset. A ConfigMap was rejected: the bundle would pass the
1 MiB limit the moment a real dependency was imported.

## Queues and Lookout

**`listActive` asks Lookout, and exists only when Lookout is configured.** The server cannot
enumerate a queue's jobs; Lookout aggregates jobs across every executor cluster, which is why
its UI can list them. The reconciler destroys what `listActive` returns, and a queue may hold
jobs that are not marimohub's, so the `marimohub/sandbox` annotation filter is the safety
property, not decoration. `QUEUED` jobs are reported deliberately: their sandbox is on its
way and must not look reapable. Pages of 500 are followed until one comes back short. The
provider advertises the capability only when `ARMADA_LOOKOUT_URL` is set, because marimohub
treats a declared `listActive` as a promise and an absent one as a clean no-op. Lookout's
API is a UI's API rather than a public contract (`internal/lookout/swagger.yaml`), so the
contract check asserts its tokens coarsely.

**The queue a job is in outranks the owner map.** Every call about a job is addressed by
queue and job set, including cancel (`internal/server/submit/submit.go:184`) and the
lookup by `externalJobUri`, and the server has no call that answers "which queue holds this
job set". A job is where it was submitted; the map is whatever the operator has today. Trusting
the map first was found wrong under review: move a project between queues while its sessions
run and `destroy` cancels in the new queue, a server-side no-op reported as success, while
the pod lives to its deadline. Worse on the submit path: `clientId` dedupe is per queue
(`jobKey(queue, clientId)`), so a sandbox marimohub creates by id alone after a restart,
which it does for surfaces, orphans and cleanup, would be resubmitted into the default queue
as a second kernel beside the first. So the order is: what this process remembers, then
Lookout by job set, then the owner map, which only places a job set Lookout holds nothing
for. A Lookout error fails the call rather than guesses; every marimohub caller retries a
failed create or destroy, and a false success is the one outcome nobody upstream can repair.
This is why a queue map requires Lookout on every marimohub version.

**The annotation's value names the installation.** It is `ARMADA_QUEUE`, the default queue
name, so both Lookout queries filter on the mark alone and find a job in a queue since
retired from the map. Two installations sharing an Armada keep distinct default queues and
never see each other's sandboxes.

**A map, not a template.** A queue must exist before a submit names it, with permissions for
the submitting credential, and a template invites a name that does not. The server answers
such a submit with a 403 `could not find queue`, and does so for a queue created seconds
earlier as well, until its queue cache refreshes. Creating queues is the operator's job.

## Deployment questions this adapter does not answer

These are judgement calls for whoever runs the cluster, and the adapter makes each of them
possible to apply without choosing.

- **Queue granularity is the fairness model.** Fair share is computed per queue with a
  per-queue priority factor (`docs/scheduling_and_preempting_jobs.md`). Which queues to
  create, who shares one, and how tenants compete is policy.
- **An idle kernel costs its full request.** Fair share is computed from the resource
  requests of running jobs, so a mostly-idle interactive session is charged all session
  long. That is capacity planning.
- **Lookout as a server-to-server dependency.** Its API is not offered as a stable public
  contract. If that is unacceptable, the adapter degrades to a no-op reconciler without it;
  the upstream answers are a list call in binoculars or a first-class enumeration API.
- **One-job job sets, continuously created and cancelled.** Nothing in the API suggests the
  server or Lookout minds, but event retention and storage per job set at scale are
  operational matters not visible from the client.
- **Where the agent image lives and how its port is exposed.** A registry the worker
  clusters can pull from, one image per architecture or a multi-arch manifest, and for an
  ingress, which of the three allowlist shapes above.

## Assumed, not verified

- That a kernel image other than the local Debian-family one provides `/bin/sh` and `git`.
- That an interactive session survives normal scheduling behaviour once the deadline, retry
  and priority settings above are applied.
- That an ingress controller other than ingress-nginx serves a class-less Ingress, carries
  the websocket, and routes to a ClusterIP service.
- That `listActive` answers against a real Lookout under auth. The tests stub its responses;
  the local cluster's Lookout runs anonymous.
- That an actual VS Code or OpenCode surface session works. The port and readiness mechanics
  are verified with a stand-in server; a kernel image shipping the surface binary was not
  tried.
