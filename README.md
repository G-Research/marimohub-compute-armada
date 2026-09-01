# marimohub-compute-armada

A [marimohub](https://github.com/marimo-team/marimohub) compute adapter that runs
notebook kernels as [Armada](https://armadaproject.io/) jobs.

Loaded through marimohub's external adapter library mode (`apiVersion: 1`), so it
needs no changes to marimohub itself.

## How it works

Armada is a batch meta-scheduler: you submit a job (a podspec plus optional
ingress and service objects) to a queue, and it places that job on one of many
Kubernetes clusters. Its API has no exec, attach or port-forward — but its job
events report `cluster_id`, `pod_name` and `pod_namespace`, so once a job is
running we exec against that cluster directly.

The adapter is therefore two halves:

- **Placement** (`src/armada.ts`) — submit a job, follow its event stream, learn
  where the pod landed and which ingress address it was assigned.
- **Control channel** (`src/exec.ts`) — exec into that pod, the same way
  marimohub's own kubernetes adapter does.

Everything in `src/sandbox.ts` above `exec` is ordinary shell commands.

## Configuration

| Variable                             | Required | Description                                          |
| ------------------------------------ | -------- | ---------------------------------------------------- |
| `ARMADA_URL`                         | yes      | Armada API base URL                                  |
| `ARMADA_QUEUE`                       | yes      | Queue jobs are submitted to                          |
| `ARMADA_NAMESPACE`                   | no       | Pod namespace (default `default`)                    |
| `ARMADA_PRIORITY_CLASS`              | no       | Use a non-preemptible class for interactive sessions |
| `ARMADA_KERNEL_PORT`                 | no       | Port marimo serves on (default `2718`)               |
| `MARIMOHUB_COMPUTE_IMAGE`            | yes      | Kernel image (first entry of the list)               |
| `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` | no       | Public kernel hostname                               |
| `ARMADA_AUTH_USERNAME`               | no       | Basic auth, set with the password                    |
| `ARMADA_AUTH_PASSWORD`               | no       | Basic auth, set with the username                    |
| `ARMADA_AUTH_TOKEN`                  | no       | Bearer token, for example from OIDC                  |
| `ARMADA_AUTH_TOKEN_FILE`             | no       | Bearer token file, re-read on every request          |
| `ARMADA_KUBECONFIG_PATTERN`          | no       | Kubeconfig path, `{CLUSTER_ID}` substituted          |

`ARMADA_KUBECONFIG_PATTERN` is how the adapter reaches the cluster a job landed on,
which Armada names only as a `clusterId`. It mirrors Lookout's `binocularsBaseUrlPattern`:
`/etc/marimohub/clusters/{CLUSTER_ID}.yaml` in a multi-cluster deployment, a plain path
when there is one cluster, and unset to use the ambient credentials (the in-cluster
service account, or `~/.kube/config` on a laptop).

Configure at most one auth mechanism. With none, no `Authorization` header is sent, which
is what a server running `anonymousAuth: true` expects. Prefer `ARMADA_AUTH_TOKEN_FILE`
for anything that rotates, such as a projected Kubernetes service account token: it is read
per request, so a new token is picked up without restarting marimohub.

## Running it locally

The Armada side comes from
[armada-operator](https://github.com/armadaproject/armada-operator), which is much
the easiest way to get one: a single `make kind-all` gives you a kind cluster
running the operator, Armada itself, and the Pulsar, Postgres and Redis it depends
on. Nothing below assembles Armada by hand.

### What you end up with

Three moving parts, all on your machine:

```
┌─ Docker ─────────────────────────────────────────────────────┐
│                                                               │
│  marimohub-armada            plain container, host port 3000  │
│  (marimohub + this adapter)                                   │
│         │                                                     │
│         │ HTTP to host.docker.internal:30001                  │
│         ▼                                                     │
│  armada-control-plane ┐                                       │
│  armada-worker        ┴─ kind cluster "armada"                │
│                                                               │
│    These two containers are Kubernetes *nodes*. Armada runs   │
│    as pods inside them (namespace `armada`), together with    │
│    Pulsar, Postgres and Redis (namespace `data`).             │
└───────────────────────────────────────────────────────────────┘
```

marimohub runs as an **ordinary Docker container, not inside Kubernetes**. It
reaches Armada over `host.docker.internal:30001`, which lands on the host port
that kind maps to the Armada server's NodePort.

### How the adapter is loaded

There is only **one process**: marimohub's own Node server. This adapter is not a
sidecar, a service, or a second process — it is a library that server imports.

At startup marimohub sees `MARIMOHUB_COMPUTE_BACKEND=library`, dynamically
`import()`s the path in `MARIMOHUB_COMPUTE_LIBRARY`, checks the default export is
`{ apiVersion: 1, kind: 'compute' }`, and calls `create(context)`. The
`SandboxProvider` it gets back then lives on marimohub's heap and is called
in-process whenever a kernel is needed.

Two consequences worth knowing:

- A configuration error here is a **startup** error. `readConfig()` throws inside
  marimohub's boot sequence, so a missing `ARMADA_URL` stops the server rather
  than failing later at session start.
- The adapter runs with the server's full privileges, which is why marimohub's
  docs say to load only trusted code in library mode.

Inside the container, do not confuse the two bundles: `/app/dist/index.mjs` is
marimohub's own server, and `/etc/marimohub/compute.mjs` is this adapter.

### Apple Silicon

Armada publishes **amd64-only** images (`gresearch/armada-*`), as does marimohub.
Both still run on an M-series Mac: Docker Desktop registers its binfmt handler
with the `F` flag, which the nested containerd inside a kind node inherits, so
amd64 pods schedule onto arm64 kind nodes. The Kubernetes control plane stays
native; only the Armada processes are emulated. The kernel image is built here
from `python:3.13-slim`, so kernels are native arm64.

### 1. Bring up Armada

```bash
git clone https://github.com/armadaproject/armada-operator
cd armada-operator
make kind-all
```

That creates the `armada` kind cluster, installs cert-manager, the operator and
Armada's dependencies, applies the Armada CRs, writes `~/.armadactl.yaml`, and
downloads `armadactl` to `./bin/app/armadactl`. It pulls several GB the first
time; `apachepulsar/pulsar-all` alone is ~3 GB.

The quickstart pins nothing: every `gresearch/armada-*` image is `latest`. Today
those serve the same API as the `v0.22.7` in `.armada-version`, verified, but the
two can drift apart without warning.

Host ports mapped by `hack/kind-config.yaml`:

| Port    | Service         |
| ------- | --------------- |
| `30000` | Lookout UI      |
| `30001` | Armada REST API |
| `30002` | Armada gRPC API |

The quickstart CRs set `anonymousAuth: true` and grant every permission to
`everyone`, so no credentials are needed locally.

Confirm Armada works on its own before involving marimohub:

```bash
./bin/app/armadactl create queue example
./bin/app/armadactl submit dev/quickstart/example-job.yaml
./bin/app/armadactl watch example job-set-1
```

### 2. Build the kernel image

marimohub needs a sandbox image with marimo + uv preinstalled. Build the
upstream example and load it into the cluster, so no registry is involved:

```bash
docker build -t marimo-sandbox:local path/to/marimohub/examples/sandbox-image
kind load docker-image marimo-sandbox:local --name armada
```

### 3. Check that placement works

Before involving marimohub, submit one job the way the adapter does:

```bash
bun run smoke            # submit, wait for the pod, cancel
bun run smoke -- --keep  # leave it running to poke at
```

```
submitting smoke-mth9i8gg to queue "marimohub" at http://localhost:30001
  job 01m1bzdp2tz93cyeh8ftzfr7nm, waiting for it to run

running after 11.7s
  cluster Cluster1
  pod     default/armada-01m1bzdp2tz93cyeh8ftzfr7nm-0
  node    armada-worker
```

```
running a command in it
  hello from armada-01m1bzdp2tz93cyeh8ftzfr7nm-0
  Python 3.13.15
  exit 0
```

That exercises the config, the auth header, the podspec, `/v1/job/submit`, the event
stream and a Kubernetes exec against a real server and a real pod. Armada also creates
the NodePort service the kernel will be reached through, which `kubectl get svc` shows
as `2718:3xxxx/TCP`.

The script runs on your machine, so it uses `~/.kube/config`. marimohub in a container
needs its own route to the API server: join the `kind` network and point a kubeconfig at
`https://armada-control-plane:6443`. The kind API server certificate lists
`armada-control-plane`, `localhost`, `127.0.0.1` and the node IP as subject alternative
names, so reaching it as `host.docker.internal` fails TLS verification.

### 4. Start marimohub with this adapter

```bash
./dev/run-local.sh
```

The script does five things:

1. `bun run build` — bundles `src/` into `dist/index.js`.
2. `docker build` — bakes that bundle into `marimohub-armada:dev`, a stock
   marimohub image plus one `COPY`.
3. `armadactl create queue marimohub` — idempotent.
4. `docker run` — starts the container on port 3000 with `fs` storage (a named
   volume), `dev` auth, and the `ARMADA_*` variables.
5. Polls `/api/health` until it answers, then prints the URL.

Override with environment variables: `ARMADA_URL`, `ARMADA_QUEUE`,
`ARMADA_NAMESPACE`, `PORT`, `IMAGE`, `CONTAINER`, `ARMADACTL`.

### 5. What you should see

marimohub comes up at <http://localhost:3000>, already signed in as the dev
user. Browsing, creating a project and creating a notebook all work — those are
storage operations and never touch compute.

**Starting a kernel now runs the whole provision sequence.** `ready()` submits
the job and waits for it to run, the file and environment step goes in over exec
(`writeFiles` streams each file through the pod's stdin; `setEnvVars` accumulates
an export prefix for later commands), `startProcess` launches the kernel detached
with `setsid` and waits for its port in-pod, and `exposePort` returns the address
Armada assigned to the NodePort service, read from `JobIngressInfoEvent`.

Two gaps remain before a notebook is usable locally. The returned URL is
`<node-ip>:<nodePort>` on the docker network, which a browser on the host cannot
reach, so connecting to the kernel needs a route (or a real Ingress, which the
adapter does not submit yet). And session capture at snapshot or teardown still
hits stubs (`readFile`, `listFiles`). When a start does fail, the notebook shows
a generic _"Sandbox compute backend is not available"_ with a Retry button; the
real error is nested in the server log's `cause` field. Dig it out with:

```bash
docker logs marimohub-armada 2>&1 | grep request_error | tail -1 | jq -r '.error.cause.message'
```

The surrounding `session_provision` line is the useful one for progress: it
reports `launch_strategy`, the chosen `image`, and which steps succeeded before
the failure. marimohub compensates cleanly on failure
(`editor_claim_compensated`, `app_claim_compensated`), so a failed start leaves
no stale claims and Retry is safe.

### Inspecting

```bash
./bin/app/armadactl get queues              # queues
./bin/app/armadactl watch <queue> <job-set> # job events
kubectl get pods -n armada                  # Armada's own components
kubectl get pods -n default                 # pods the executor created
docker logs -f marimohub-armada             # marimohub, including adapter errors
```

Lookout UI: <http://localhost:30000>.

### Tearing down

```bash
docker rm -f marimohub-armada
make kind-delete-cluster    # from armada-operator
```

## Development

```bash
bun install
bun run build   # bundles src + all dependencies into dist/index.js (bun build --target=node)
bun run test
bun run smoke   # submit one job to a running Armada, see where it lands
```

CI (`.github/workflows/ci.yml`) runs `check` (oxfmt + oxlint), `typecheck`, `test` and
`build` on every push to `main` and every pull request.

### Armada API surface

`src/armada-types.ts` is hand-written rather than generated from Armada's swagger. The
four endpoints we call reach 202 of the spec's 249 definitions, but 165 of those are
embedded Kubernetes types already available from `@kubernetes/client-node`, and only a
dozen of the rest are ones we read. Generating would mean re-reviewing six thousand lines
on every Armada release for endpoints we never touch.

What keeps that honest is `bun run check:armada-api`. It fetches `api.swagger.json` at the
release pinned in `.armada-version` and asserts that every field we depend on still exists
with the type we read it as, so a drifting API fails in CI rather than at runtime:

```bash
bun run check:armada-api                          # against the pinned version
ARMADA_VERSION=v0.23.0 bun run check:armada-api   # try a candidate
```

CI runs it in the `armada-api` job, which reports on every PR but only fetches the spec
when an Armada-related file changed. There is no scheduled run: the spec is fetched at a
git tag, and a tag is immutable, so the result can only change when this repo does.

`dist/index.js` is fully self-contained: marimohub imports it from wherever it is
mounted, with no `node_modules` beside it. Now that the adapter really loads
`@kubernetes/client-node`, the bundle is about 8 MB: that client depends on
`undici`, `openid-client`, `tar-fs` and `socks`, and bundling reaches all of them
even though the import is lazy. That is far past the 1 MiB ConfigMap limit, so
ship it via a volume or a one-line derived image (`COPY dist/index.js …`), which
is what the Dockerfile here does. Size is not otherwise interesting: it is one
layer in an image that already carries a Node runtime.

The bundle is deliberately not minified. When a kernel fails to start, the useful
error is a stack trace in marimohub's log, and the Dockerfile ships no source map.

Point a local marimohub dev server at the build output:

```bash
# marimohub/apps/server/.env
MARIMOHUB_COMPUTE_BACKEND=library
MARIMOHUB_COMPUTE_LIBRARY=/absolute/path/to/marimohub-compute-armada/dist/index.js
```

## Deployment

```bash
bun run build
docker build --platform linux/amd64 -t <registry>/marimohub-armada:<tag> .
```

The Dockerfile is the whole deployment story: stock marimohub image plus one
`COPY` of the bundle, with `MARIMOHUB_COMPUTE_BACKEND=library` and
`MARIMOHUB_COMPUTE_LIBRARY` preset. Armada settings (`ARMADA_URL`,
`ARMADA_QUEUE`, …) come from the runtime environment, not the image.
`--platform linux/amd64` is required on Apple Silicon: the upstream image
ships no arm64 variant, so local runs go through Rosetta.

Verified against `ghcr.io/marimo-team/marimohub:0.3.12`: the server boots with
the adapter loaded, and a missing `ARMADA_URL` fails startup with this
adapter's own error wrapped in marimohub's config diagnostics.

## Toolchain

- **Node 24** — matches marimohub's `.node-version` and its `node:24-slim` runtime
  image. `@types/node` tracks the same major on purpose: newer types would
  describe APIs the runtime does not have.
- `src/` is typed against Node only (`tsconfig.src.json`), so Bun globals
  cannot leak into shipped code. Bun types are available in `test/` alone.
- Tests use `bun test`. If the marimohub conformance suite
  (`@marimo-hub/core/testing/compute-contract`) is wired up later it imports
  `vitest`, so it needs its own runner at that point.
