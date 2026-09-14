# marimohub-compute-armada

A [marimohub](https://github.com/marimo-team/marimohub) compute adapter that runs
notebook kernels as [Armada](https://armadaproject.io/) jobs.

Loaded through marimohub's external adapter library mode (`apiVersion: 1`), so it
needs no changes to marimohub itself.

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
| `MARIMOHUB_COMPUTE_IMAGE`            | yes      | Kernel image (first entry of the list)                |
| `ARMADA_NAMESPACE`                   | no       | Pod namespace (default `default`)                     |
| `ARMADA_LOOKOUT_URL`                 | no       | Lookout base URL; enables `listActive` reconciliation |
| `ARMADA_PRIORITY_CLASS`              | no       | Use a non-preemptible class for interactive sessions  |
| `ARMADA_KERNEL_PORT`                 | no       | Port marimo serves on (default `2718`)                |
| `ARMADA_AGENT_PORT`                  | no       | Port the agent listens on (default `8718`)            |
| `ARMADA_COMMAND_MAX_SECONDS`         | no       | Backstop for one exec (default `21600`, `0` off)      |
| `ARMADA_EXPOSE`                      | no       | `nodeport` (default) or `ingress`, for both ports     |
| `ARMADA_INGRESS_TLS`                 | no       | `true` (default) or `false`; ingress only             |
| `ARMADA_INGRESS_CERT_NAME`           | no       | TLS secret name prefix (default `<namespace>-`)       |
| `ARMADA_INGRESS_ANNOTATIONS`         | no       | JSON object put on every job's Ingress                |
| `ARMADA_QUEUE_BY_USER`               | no       | JSON object, marimohub user id to queue               |
| `ARMADA_QUEUE_BY_PROJECT`            | no       | JSON object, marimohub project id to queue            |
| `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` | no       | Public kernel hostname                                |
| `ARMADA_AUTH_USERNAME`               | no       | Basic auth, set with the password                     |
| `ARMADA_AUTH_PASSWORD`               | no       | Basic auth, set with the username                     |
| `ARMADA_AUTH_TOKEN`                  | no       | Bearer token, for example from OIDC                   |
| `ARMADA_AUTH_TOKEN_FILE`             | no       | Bearer token file, re-read on every request           |

Configuration is validated at startup, so a missing variable stops marimohub from
booting rather than failing at the first session.

`ARMADA_AGENT_IMAGE` has no default because the image is not published anywhere
public yet: build it from `agent/` for the architecture of the worker nodes (see
Deployment). The agent port is exposed the same way as the kernel port, so whatever
reaches one reaches the other.

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
allowlist for the agent's hostname, or a longer websocket read timeout, go there.

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
the pod spec. It is exposed exactly as the kernel port is: over a NodePort that is
plaintext HTTP on the cluster network, over an ingress it is a public HTTPS hostname.
Restrict the ingress to marimohub's egress address in the latter case, through
`ARMADA_INGRESS_ANNOTATIONS` or the executor's cluster-wide ingress annotations.

Verified against `ghcr.io/marimo-team/marimohub:0.4.2`, the release the adapter interface
is transcribed from; everything added since 0.3.12 is optional, so that release loads it too.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the three systems, the agent, and
  how one session flows through them.
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md): toolchain, checks, running the whole
  thing locally, and what to update when you change something.
- [ARMADA-REVIEW.md](ARMADA-REVIEW.md): every design decision, with evidence cited
  against the pinned Armada release, and what is still open.
- [AGENT-DESIGN.md](AGENT-DESIGN.md): the design of the in-pod agent, written by an
  Armada maintainer.

## License

Apache-2.0, see [LICENSE](LICENSE).
