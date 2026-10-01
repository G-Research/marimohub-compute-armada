# marimohub-compute-armada

A [marimohub](https://github.com/marimo-team/marimohub) compute adapter that runs
notebook kernels as [Armada](https://armadaproject.io/) jobs.

Loaded through marimohub's external adapter library mode (`apiVersion: 1`), so it
needs no changes to marimohub itself.

## Status

Nothing is published yet: no npm package, no marimohub image with the adapter in it, and no
agent image. To try it, clone this repository and build both images yourself (see
[Deployment](#deployment)); [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) walks through a
full run against a local kind cluster. Publishing the agent image is planned, but not soon.

## How it works

Armada is a batch meta-scheduler: you submit a job to a queue and it places the pod
on one of many Kubernetes clusters. Its API has no exec, and it exists to keep cluster
credentials away from the tools that use it. Each kernel session becomes one Armada
job.

Because Armada cannot run commands in a pod, the kernel container runs a small
**agent** as PID 1 (`agent/`, a static Go binary) instead of `sleep infinity`. It
listens on a second port next to marimo's and runs the commands marimohub sends it.
Armada exposes both ports and reports both addresses, so the adapter reaches the pod
with an address Armada handed it and a token minted for that one pod, and holds no
Kubernetes credential of any kind.

The adapter is two halves: **placement** (`src/armada.ts`) submits the job and follows
its events, and the **control channel** (`src/channel.ts`) talks to the agent.
Everything above that is ordinary shell commands. The full picture, with diagrams, is
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

| Variable                             | Required | Description                                           |
| ------------------------------------ | -------- | ----------------------------------------------------- |
| `ARMADA_URL`                         | yes      | Armada REST API base URL                              |
| `ARMADA_QUEUE`                       | yes      | Queue jobs are submitted to                           |
| `ARMADA_AGENT_IMAGE`                 | yes      | Kernel agent image, run as the init container         |
| `ARMADA_AGENT_TOKEN_SECRET`          | yes      | Key agent tokens derive from; 32+ chars, shared       |
| `MARIMOHUB_COMPUTE_IMAGE`            | no       | Kernel image, first of the list (default marimo's)    |
| `ARMADA_NAMESPACE`                   | no       | Pod namespace (default `default`)                     |
| `ARMADA_LOOKOUT_URL`                 | no       | Lookout base URL; enables `listActive` reconciliation |
| `ARMADA_PRIORITY_CLASS`              | no       | Use a non-preemptible class for interactive sessions  |
| `ARMADA_KERNEL_PORT`                 | no       | Port marimo serves on (default `2718`)                |
| `ARMADA_AGENT_PORT`                  | no       | Port the agent listens on (default `8718`)            |
| `ARMADA_IMAGE_PULL_SECRETS`          | no       | Comma-separated secret names for private registries   |
| `ARMADA_RUN_AS_USER`                 | no       | Pod `securityContext.runAsUser`, a uid                |
| `ARMADA_RUN_AS_GROUP`                | no       | Pod `securityContext.runAsGroup`, a gid               |
| `ARMADA_FS_GROUP`                    | no       | Pod `securityContext.fsGroup`; owns the agent volume  |
| `ARMADA_COMMAND_MAX_SECONDS`         | no       | Backstop for one exec (default `21600`, `0` off)      |
| `ARMADA_EXPOSE`                      | no       | `nodeport` (default) or `ingress`, for both ports     |
| `ARMADA_INGRESS_TLS`                 | no       | `true` (default) or `false`; ingress only             |
| `ARMADA_INGRESS_CERT_NAME`           | no       | TLS secret name prefix (default `<namespace>-`)       |
| `ARMADA_INGRESS_ANNOTATIONS`         | no       | JSON object put on every job's Ingress                |
| `ARMADA_POD_LABELS`                  | no       | JSON object of labels put on every kernel pod         |
| `ARMADA_POD_ANNOTATIONS`             | no       | JSON object of annotations put on every kernel pod    |
| `ARMADA_QUEUE_BY_USER`               | no       | JSON object, marimohub user id to queue               |
| `ARMADA_QUEUE_BY_PROJECT`            | no       | JSON object, marimohub project id to queue            |
| `ARMADA_GPU_NODE_SELECTORS`          | no       | JSON object, GPU type to node selector; enables GPUs  |
| `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` | no       | Public kernel hostname                                |
| `ARMADA_AUTH_USERNAME`               | no       | Basic auth, set with the password                     |
| `ARMADA_AUTH_PASSWORD`               | no       | Basic auth, set with the username                     |
| `ARMADA_AUTH_TOKEN`                  | no       | Bearer token, for example from OIDC                   |
| `ARMADA_AUTH_TOKEN_FILE`             | no       | Bearer token file, re-read on every request           |

Configuration is validated at startup, so a missing variable stops marimohub from
booting rather than failing at the first session.

`MARIMOHUB_COMPUTE_IMAGE` defaults to `ghcr.io/marimo-team/marimo-sandbox:latest`, marimo's
own kernel image, as marimohub's kubernetes adapter defaults its own. It is public and amd64.
`ARMADA_AGENT_IMAGE` has no default because the image is not published: build it from
`agent/` for the architecture of the worker nodes (see Deployment). The agent port is
exposed the same way as the kernel port, so whatever reaches one reaches the other.

`ARMADA_AGENT_TOKEN_SECRET` is the key each sandbox's agent token is derived from, with
the sandbox id. Generate it once (`openssl rand -hex 32`) and give every marimohub process
running the adapter the same value: marimohub stops and snapshots a session through
whichever process gets there, and a process with a different secret is refused by the
pod. Changing it cuts every running session off from its agent, so their edits can no
longer be saved; rotate it when no sessions are running. The same holds once for the
upgrade that introduced it: pods started by an earlier version carry a random token no
process can derive, so upgrade with no sessions running, or expect those sessions' last
edits to be lost when they end.

Both images are pulled by the worker cluster, never by marimohub, so a private registry
needs a credential the cluster holds: `ARMADA_IMAGE_PULL_SECRETS` names one or more
secrets in `ARMADA_NAMESPACE`, and every pod lists them as `imagePullSecrets`. A secret's
registry host must match the image reference's host exactly (`ghcr.io` is not
`https://ghcr.io/v2/`); a mismatch does not fail at startup, it surfaces later as
`ImagePullBackOff` on the pod.

A cluster may run an admission policy that rejects a pod which does not say who it runs
as (the failure is literally `runAsUser not specified`). `ARMADA_RUN_AS_USER`,
`ARMADA_RUN_AS_GROUP` and `ARMADA_FS_GROUP` fill the pod-level `securityContext`, so the
init container that copies the agent runs with the same ids as the kernel. None has a
default: a guessed uid is wrong on every cluster that does not need one, and which uid a
kernel image tolerates is a property of that image. `ARMADA_FS_GROUP` matters as much as
`ARMADA_RUN_AS_USER`: the agent's volume is an `emptyDir`, mounted root-owned, so a
non-root user cannot have the agent written into it unless the volume is group-owned by
a group the pod runs with. Without `fsGroup`, the init container's `agent install` fails
with a permission error before the kernel ever starts.

`ARMADA_EXPOSE` decides how those two ports are reached. `nodeport` asks Armada for a
NodePort service: plaintext HTTP on the cluster's own network, which is what a local
cluster offers with nothing installed and is enough when marimohub runs beside it in
`proxy` exposure. `ingress` asks for an Ingress instead: one hostname per port, named by
the executor's `podDefaults.ingress.hostnameSuffix`, served over HTTPS by the cluster's
ingress controller. Armada's Ingress names no class, so the cluster needs a default
IngressClass or an annotation naming one; the executor's suffix must be a wildcard DNS
record for the controller; and the TLS secret, `<namespace>-` (or
`ARMADA_INGRESS_CERT_NAME`) plus the executor's `certNameSuffix`, must hold a wildcard
certificate for `*.<namespace>.<suffix>` that marimohub trusts (`NODE_EXTRA_CA_CERTS` for
a private CA). `ARMADA_INGRESS_ANNOTATIONS` lands on every job's Ingress: a source
allowlist for the agent's hostname, or a longer websocket read timeout, go there. It is
part of the submission, so everyone with Lookout access reads it (see
[What Armada shows everyone](#what-armada-shows-everyone)).

`ARMADA_POD_LABELS` and `ARMADA_POD_ANNOTATIONS` tag every kernel pod with fixed values,
for cost allocation, admission policies or `kubectl -l`. Armada copies them from the job
onto the pod, and Lookout shows the annotations. Armada does not check them at submit, so
the adapter applies Kubernetes' rules at startup: a key or a label value the cluster would
refuse stops marimohub rather than failing every session. Keys starting with `armada_` or
`armadaproject.io/`, and `marimohub/sandbox`, are reserved. The pod's Service and Ingress
do not get these labels. Both are public to everyone with Lookout access, so neither may
hold a credential (see [What Armada shows everyone](#what-armada-shows-everyone)).

```bash
ARMADA_POD_LABELS='{"team": "quant", "example.com/cost-center": "cc-1234"}'
ARMADA_POD_ANNOTATIONS='{"example.com/contact": "quant@example.com"}'
```

`ARMADA_QUEUE` takes every sandbox unless its owner maps elsewhere. Armada computes fair
share and priority per queue, so a queue per team or per user is how tenants are told
apart. `ARMADA_QUEUE_BY_USER` and `ARMADA_QUEUE_BY_PROJECT` map marimohub ids to queue
names, the user's entry winning; every queue named must already exist, with permissions
for the configured credential. marimohub names the owner on the calls where it holds a
session record (marimohub#301, released in 0.4.0), and the owner places a sandbox that does
not exist yet. For one that does, the queue it is in is the answer whatever the map says
today: the adapter remembers it, takes it from Lookout during `listActive`, and asks
Lookout by job set for a sandbox it has never seen, since marimohub addresses sandboxes by
id alone on several paths. A queue map therefore requires `ARMADA_LOOKOUT_URL`, and a
call Lookout cannot answer fails rather than guesses; marimohub retries it.

Compute profiles (`MARIMOHUB_COMPUTE_PROFILES`, marimohub 0.4.13 onwards) let editors
pick hardware per notebook: when creating it, later through "Change compute profile", or
for one edit session. The adapter tells marimohub it applies them, and a profile's CPU
and memory become the kernel container's requests and limits, which Armada requires to
be equal. So a kernel that outgrows its profile's memory is OOM-killed, and every session
is charged its full profile against the queue's fair share, idle or not. Offer a short
list of sizes rather than one large default. Users can only pick when
`MARIMOHUB_COMPUTE_PROFILE_OVERRIDE=editors`.

```bash
MARIMOHUB_COMPUTE_PROFILES='small:cpu=1;mem=4Gi,large:cpu=4;mem=32Gi,a100:cpu=8;mem=64Gi;gpu=A100'
MARIMOHUB_COMPUTE_PROFILE_OVERRIDE=editors
ARMADA_GPU_NODE_SELECTORS='{"A100": {"nvidia.com/gpu.product": "NVIDIA-A100-SXM4-80GB"}}'
```

A profile's GPU count becomes an `nvidia.com/gpu` request. Its type is placement, so
GPU profiles are only on when `ARMADA_GPU_NODE_SELECTORS` maps every type the profiles
name to a `nodeSelector`; without the map, marimohub drops the GPUs from every profile
and says so at startup, and a type the map misses stops startup. The label values are
the cluster's (`kubectl get nodes -L nvidia.com/gpu.product`), and every label used must
be in each executor's `kubernetes.trackedNodeLabels`: the scheduler only sees tracked
labels, so a selector on any other stays queued for good.

Session surfaces (VS Code or OpenCode inside the sandbox, `MARIMOHUB_SURFACES`) need a
port each next to the kernel's. The adapter reads marimohub's own `MARIMOHUB_SURFACES`
and `MARIMOHUB_SURFACE_<ID>_PORT` settings, declares those ports on every pod so Armada
exposes them like the kernel's, and advertises `multiPort` exactly then. A surface port
may not be the agent's. The kernel image must ship the surface's binary.

`ARMADA_LOOKOUT_URL` gates a capability: set it and the adapter advertises
`listActive`, which marimohub's reconciler uses to enumerate live sandboxes after a
restart. Leave it unset and reconciliation is a clean no-op.

Configure at most one auth mechanism. With none, no `Authorization` header is sent,
which is what a server running `anonymousAuth: true` expects. Prefer
`ARMADA_AUTH_TOKEN_FILE` for anything that rotates: it is read per request.

## What Armada shows everyone

Armada keeps every job submission and serves it back whole: its API returns the pod spec,
and Lookout shows the submission to everyone who can open the job. Once submitted, nothing
takes it back. Treat every value below as readable by everyone with Lookout access, for
good, and never put a credential in one. The two tables are the whole submission
(`src/armada.ts` builds it, `src/podspec.ts` the pod spec in it).

What configuration decides:

| In the submission       | Comes from                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| Queue and namespace     | `ARMADA_QUEUE` (or the owner's entry in `ARMADA_QUEUE_BY_*`), `ARMADA_NAMESPACE` |
| Kernel and agent images | `MARIMOHUB_COMPUTE_IMAGE` (the one marimohub asks for), `ARMADA_AGENT_IMAGE`     |
| Pod labels              | `ARMADA_POD_LABELS`                                                              |
| Pod annotations         | `ARMADA_POD_ANNOTATIONS`                                                         |
| Exposure                | `ARMADA_EXPOSE`: a NodePort service or an Ingress                                |
| Ingress settings        | `ARMADA_INGRESS_TLS`, `ARMADA_INGRESS_CERT_NAME`, `ARMADA_INGRESS_ANNOTATIONS`   |
| Ports                   | `ARMADA_KERNEL_PORT`, `ARMADA_AGENT_PORT`, `MARIMOHUB_SURFACE_<ID>_PORT`         |
| Resources               | The compute profile's CPU, memory and GPU count                                  |
| Node selector           | `ARMADA_GPU_NODE_SELECTORS`, the entry for the profile's GPU type                |
| Priority class          | `ARMADA_PRIORITY_CLASS`                                                          |
| Pull secrets            | `ARMADA_IMAGE_PULL_SECRETS`, the secret names only                               |
| Pod security context    | `ARMADA_RUN_AS_USER`, `ARMADA_RUN_AS_GROUP`, `ARMADA_FS_GROUP`                   |
| Deadline                | marimohub's session lifetime, else `ARMADA_KERNEL_MAX_LIFETIME_SECONDS`          |

What the adapter fixes:

| In the submission                       | Value                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Job set id, client id, external job URI | The sandbox id                                                            |
| Annotations                             | `armadaproject.io/failFast: "true"`, `marimohub/sandbox` set to the queue |
| One pod environment variable            | `MH_AGENT_TOKEN_SHA256`, the SHA-256 of the agent token, never the token  |
| Pod lifecycle                           | Restart policy `Never`, a 30s grace period                                |
| Agent install                           | The `mh-agent` volume and the init container that copies the agent in     |
| Container commands                      | `/agent install …` and `/mh-agent/agent --port <ARMADA_AGENT_PORT>`       |
| Ingress service                         | `useClusterIP: true`                                                      |

Every configured value is copied in as written. The adapter checks each one's shape,
such as a valid label key or a nonblank name, and nothing more: it cannot tell a
credential from any other string. The free-form maps are where one is most likely to be
pasted: `ARMADA_POD_ANNOTATIONS`, `ARMADA_INGRESS_ANNOTATIONS`, and `ARMADA_POD_LABELS`
within the label character set. Some ingress annotations invite a credential: an
ingress-nginx `configuration-snippet` that sets an `Authorization` header, or an `auth-url`
with a key in its query string. Name a Kubernetes Secret instead
(`nginx.ingress.kubernetes.io/auth-secret`), the way `ARMADA_IMAGE_PULL_SECRETS` does for
registries.

No variable sets an environment variable on the pod, by design: a value set that way is
in the spec. `ARMADA_AGENT_TOKEN_SECRET`, the agent tokens and the `ARMADA_AUTH_*`
credentials never enter a submission; the auth credentials only ever travel as an
`Authorization` header to Armada and Lookout.

Notebook users cannot put anything in a submission: they pick a compute profile and an
image from lists the operator wrote. The credentials they give marimohub for an
integration, such as a database password or a cloud key, become the session's environment,
which the adapter hands to the pod through the agent, as `export` statements in front of
each command. So those credentials:

- stay out of the submission and out of Lookout;
- cross the network as plain HTTP under `ARMADA_EXPOSE=nodeport`, readable by anyone who
  can watch the cluster network; use `ingress` with TLS where that matters;
- are visible to every process in the kernel container, as on any marimohub backend;
- never appear in the adapter's own error messages, which name the program run and never
  its arguments.

What a notebook prints stays out of Lookout as well. The kernel's output goes to a log file
inside the pod and command output goes back over the agent, so the container log, which is
what Lookout's log view shows, holds only the agent's own lines.

Before a deployment goes live, walk whoever sets these variables through this section. The
adapter keeps the credentials it handles out of the submission; it cannot stop a person
typing one into a variable that is public by design.

## Deployment

```bash
bun run build
docker build --platform linux/amd64 -t <registry>/marimohub-armada:<tag> .
docker build --platform linux/amd64 -t <registry>/marimohub-kernel-agent:<tag> agent
```

Two images:

- **marimohub with the adapter baked in.** The stock marimohub image plus one `COPY`
  of the bundle, with `MARIMOHUB_COMPUTE_BACKEND=library` and
  `MARIMOHUB_COMPUTE_LIBRARY` preset. Armada settings come from the runtime
  environment, not the image. `--platform linux/amd64` is required on Apple Silicon:
  the upstream image ships no arm64 variant.
- **The agent.** A few megabytes, pushed to a registry the worker clusters can pull
  from and named in `ARMADA_AGENT_IMAGE`. Build it for the architecture of the worker
  nodes (or both, with `buildx`); it runs there, not where marimohub runs.

The agent authenticates every request with a per-session token whose hash travels in
the pod spec; the token is derived from `ARMADA_AGENT_TOKEN_SECRET`, so that secret is
what guards every agent. It is exposed exactly as the kernel port is: over a NodePort that is
plaintext HTTP on the cluster network, over an ingress it is a public HTTPS hostname.
Restrict the ingress to marimohub's egress address in the latter case, through
`ARMADA_INGRESS_ANNOTATIONS` or the executor's cluster-wide ingress annotations.

### Without the marimohub image

Each marimohub release also ships `marimohub-linux-x64`, a standalone server binary for
x86-64 Linux hosts with no Node installed. It loads the adapter the same way the image
does, so the Dockerfile is optional: put the bundle somewhere on the host and point the
binary at it. The agent image is still needed, since it runs in the cluster.

```bash
# The bundle: one self-contained file, built with `bun run build`.
sudo install -D dist/index.js /etc/marimohub/compute.mjs

# The binary, at the release the Dockerfile names, checked against its published hash.
V=0.4.13
curl -fsSLO "https://github.com/marimo-team/marimohub/releases/download/v$V/marimohub-linux-x64"
curl -fsSLO "https://github.com/marimo-team/marimohub/releases/download/v$V/marimohub-linux-x64.sha256"
sha256sum -c marimohub-linux-x64.sha256
sudo install marimohub-linux-x64 /usr/local/bin/marimohub

# marimohub's own settings (storage, auth, exposure) as documented upstream, then:
export MARIMOHUB_COMPUTE_BACKEND=library
export MARIMOHUB_COMPUTE_LIBRARY=/etc/marimohub/compute.mjs
export ARMADA_URL=https://armada.example.com
export ARMADA_QUEUE=marimohub
# The agent image runs in the cluster in front of each kernel; it is the one
# thing you push yourself. The kernel image defaults to the one marimo publishes.
export ARMADA_AGENT_IMAGE=<registry>/marimohub-kernel-agent:<tag>
# The key agent tokens derive from: generated once, then kept, because every
# process running the adapter needs the same one, across restarts too.
[ -f ~/.config/marimohub/agent-token-secret ] ||
  (umask 077 && mkdir -p ~/.config/marimohub && openssl rand -hex 32 >~/.config/marimohub/agent-token-secret)
export ARMADA_AGENT_TOKEN_SECRET="$(cat ~/.config/marimohub/agent-token-secret)"
marimohub
```

The path in `MARIMOHUB_COMPUTE_LIBRARY` must be absolute. On first start the binary
unpacks its bundled files to `~/.cache/marimohub-sea/<build-id>` (or
`MARIMOHUB_SEA_CACHE_DIR`); the directory has to be owned by the running user and not
reachable through a directory other users can write, so give a service account a home or
a cache directory of its own. See marimohub's deployment docs for the rest. A bad Armada
setting fails at startup here too, with the variable named.

The kernel image, `MARIMOHUB_COMPUTE_IMAGE`, is `ghcr.io/marimo-team/marimo-sandbox:latest`
unless set: marimo's own, public and amd64, with `latest-vscode`, `latest-opencode` and
`latest-tools` variants for session surfaces. Any cluster whose nodes can pull from
GitHub's registry can leave it alone; nothing about it is specific to this adapter. Set
it to your own build of marimohub's `examples/sandbox-image` when the nodes are arm64,
cannot reach the internet, or you want a pinned marimo.

The agent image is the one thing this adapter adds to the cluster, so it is the one
thing you must build and push. A real Armada cluster pulls from a registry its
executors can reach. A local kind cluster needs no registry: a kind node can be handed
an image straight from your Docker daemon.

```bash
docker build -t marimohub-kernel-agent:local agent
kind load docker-image marimohub-kernel-agent:local --name armada
export ARMADA_AGENT_IMAGE=marimohub-kernel-agent:local
```

`dev/run-native.sh` scripts the local arrangement end to end, including the load; see
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md), which also covers the case where
`kind load` trips over a multi-platform image.

Verified against `ghcr.io/marimo-team/marimohub:0.4.2`, the release the adapter interface
is transcribed from; everything added since 0.3.12 is optional, so that release loads it too.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the three systems, the agent, and
  how one session flows through them.
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md): toolchain, checks, running the whole
  thing locally, and what to update when you change something.
- [docs/DECISIONS.md](docs/DECISIONS.md): why the adapter is shaped the way it is, with
  the evidence cited against the pinned Armada release, and what is left to a deployment.

## License

Copyright 2026 G-Research. Apache-2.0, see [LICENSE](LICENSE).
