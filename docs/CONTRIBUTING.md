# Contributing

How to build, check and run this adapter, and what to update when you change it.

## Toolchain

- **Bun** runs the scripts, tests and the bundler.
- **Node 24** is the runtime the bundle targets: it matches marimohub's
  `.node-version`. `@types/node` tracks the same major on purpose. `src/` is typed
  against Node only (`tsconfig.src.json`), so Bun globals cannot leak into shipped
  code; Bun types are available in `test/` alone.
- **Go 1.26** builds the agent (`agent/go.mod`, standard library only). Any Go that
  honours the `go` directive fetches the right toolchain.
- **golangci-lint v2.13+** lints and format-checks the agent (`agent/.golangci.yml`).
  Install it with `brew install golangci-lint`, as the
  [project recommends](https://golangci-lint.run/docs/welcome/install/local/#homebrew).
  A build older than the module's Go cannot typecheck it, so keep it current.
- **Docker** and a **kind** cluster with Armada in it, for anything live.

## Commands

```bash
bun install
bun run check             # oxfmt, oxlint (type-aware), then golangci-lint fmt and run
bun run typecheck         # both tsconfigs
bun run test              # adapter tests, then go vet and go test
bun run build             # bundles src into dist/index.js, self-contained
bun run fmt               # formats TypeScript, Markdown, YAML and Go
bun run check:armada-api  # the wire types against the pinned Armada spec
bun run smoke             # one job against a running Armada, through the agent
```

CI (`.github/workflows/ci.yml`) runs `check`, `typecheck`, `test` and `build`, lints
and builds the agent in its own job, and verifies the Armada API contract when an
Armada-related file changed. Every GitHub Action is pinned to a full-length commit
SHA; keep it that way.

### Lint rules that cost time

- A custom rule requires an explicit type annotation on every variable, arrow
  function and parameter whose type is not a primitive, tests included.
- `no-await-in-loop` needs a `// oxlint-disable-next-line` with a reason, or a
  disable/enable pair around a loop.
- The agent's Linux-only file (`agent/reaper_linux.go`) is skipped by a macOS lint
  run; lint with `GOOS=linux golangci-lint run` before pushing, since CI is Ubuntu.

### The Armada API surface

`src/armada-types.ts` is hand-written rather than generated from Armada's swagger:
the four endpoints we call reach most of the spec's definitions, but almost all are
embedded Kubernetes types, and generating would mean re-reviewing thousands of lines
per Armada release. `bun run check:armada-api` keeps the hand-written types honest by
fetching `api.swagger.json` at the release in `.armada-version` and asserting every
field we depend on still exists with the type we read it as. When you read a new
field, add it to the manifest in `scripts/check-armada-api.ts`. To try a candidate
release: `ARMADA_VERSION=v0.23.0 bun run check:armada-api`.

### The bundle

`dist/index.js` is fully self-contained: marimohub imports it from wherever it is
mounted, with no `node_modules` beside it. It is about 40 KB; `@kubernetes/client-node`
is a dev dependency used for its pod spec types only, so nothing of it is bundled. The
bundle is deliberately not minified, because the useful error when a kernel fails to
start is a stack trace in marimohub's log.

To point a marimohub dev server at a local build:

```bash
# marimohub/apps/server/.env
MARIMOHUB_COMPUTE_BACKEND=library
MARIMOHUB_COMPUTE_LIBRARY=/absolute/path/to/marimohub-compute-armada/dist/index.js
```

## Running the whole thing locally

The Armada side comes from
[armada-operator](https://github.com/armadaproject/armada-operator): one
`make kind-all` gives you a kind cluster running the operator, Armada, and the
Pulsar, Postgres and Redis it depends on.

```mermaid
flowchart TB
  subgraph docker[Docker on your machine]
    hub["marimohub-armada: marimohub + this adapter, host port 3000"]
    subgraph kind[kind cluster armada, docker network kind]
      cp[armada-control-plane]
      worker["armada-worker: Armada pods, kernel pods"]
    end
  end
  hub -->|"host.docker.internal:30001"| cp
  hub -->|"agent and kernel NodePorts, 172.18.x.x"| worker
```

marimohub runs as an ordinary Docker container, not inside Kubernetes, joined to the
`kind` network so it can reach the NodePort addresses Armada reports. macOS cannot
route to those addresses, which is why the smoke script runs in a container too.

### Apple Silicon

Armada publishes amd64-only images, as does marimohub. Both run on an M-series Mac
through Docker Desktop's binfmt handler, which the containerd inside a kind node
inherits. The kernel image and the agent image are built native arm64, for the node.

### 1. Bring up Armada

```bash
git clone https://github.com/armadaproject/armada-operator
cd armada-operator
make kind-all
```

That creates the `armada` kind cluster, installs everything, writes
`~/.armadactl.yaml` and downloads `armadactl` to `./bin/app/armadactl`. It pulls
several GB the first time. The quickstart pins nothing: every Armada image is
`latest`, which today serves the same API as the release in `.armada-version`, but the
two can drift.

Host ports mapped by `hack/kind-config.yaml`: `30000` Lookout UI, `30001` Armada REST
API, `30002` Armada gRPC API. The quickstart sets `anonymousAuth: true`, so no
credentials are needed locally.

Confirm Armada works on its own before involving marimohub:

```bash
./bin/app/armadactl create queue example
./bin/app/armadactl submit dev/quickstart/example-job.yaml
./bin/app/armadactl watch example job-set-1
```

### 2. Build the kernel image and the agent image

marimohub needs a sandbox image with marimo and uv preinstalled. Build the upstream
example and load it into the cluster, so no registry is involved:

```bash
docker build -t marimo-sandbox:local path/to/marimohub/examples/sandbox-image
kind load docker-image marimo-sandbox:local --name armada
```

The agent image is built from this repo for the worker node's architecture.
`dev/run-local.sh` does this itself; by hand:

```bash
docker build --platform linux/arm64 -t marimohub-kernel-agent:local agent
docker save marimohub-kernel-agent:local |
  docker exec -i armada-worker ctr -n k8s.io images import --platform linux/arm64 -
```

The import goes straight into the node's containerd because `kind load` trips over
multi-platform manifests from Docker Desktop's containerd image store.

If you bring your own kernel image, it must provide `/bin/sh` and `git`
(ARMADA-REVIEW.md, decision 22).

### 3. Check that placement works

```bash
bun run smoke            # submit, reach the agent, check for leaks, cancel
bun run smoke -- --keep  # leave it running to poke at
```

```
submitting smoke-mtr8nhti to queue "marimohub" at http://host.docker.internal:30001
  kernel image marimo-sandbox:local
  agent image  marimohub-kernel-agent:local
  agent   172.18.0.2:32114

running and answering after 16.8s
  cluster Cluster1
  pod     default/armada-01m1xypqftnw12bt27vyxtwksd-0
  node    armada-worker

running a command in it
  hello from armada-01m1xypqftnw12bt27vyxtwksd-0
  Python 3.13.15
  PID 1 is /mh-agent/agent--port8718
  ok: exec through the agent
```

That exercises the config, the auth header, the pod spec with its init container, the
submit, the event stream, the address event for both ports, and the agent itself. It
then writes, reads and lists a file with a hostile name through the agent's `/files`
endpoints, starts a detached server and waits for its port, kills it, starts a process
that crashes at once, and finally abandons a command by timing it out and cancels a
stream mid-command. A healthy run shows every check pass and lists no process left
behind, zombies included: the agent kills what its callers abandon and reaps the rest.
Anything else exits non-zero.

`bun run smoke` runs `dev/smoke.ts` inside a bun container on the `kind` network
(`dev/smoke.sh`). On a Linux host that can reach that network, run the script
directly.

### 4. Start marimohub with this adapter

```bash
./dev/run-local.sh
```

The script bundles the adapter, builds and imports the agent image, bakes the bundle
into `marimohub-armada:dev`, creates the `marimohub` queue, starts the container on
port 3000 joined to the `kind` network with `fs` storage, `dev` auth and `proxy`
sandbox exposure, and polls `/api/health` until it answers. No credential of any kind
is mounted. Override with `ARMADA_URL`, `ARMADA_QUEUE`, `ARMADA_NAMESPACE`, `PORT`,
`IMAGE`, `AGENT_IMAGE`, `CONTAINER`, `ARMADACTL` and `NODE`.

### 5. What you should see

marimohub comes up at <http://localhost:3000>, signed in as the dev user. Browsing and
creating notebooks never touch compute. Opening a notebook runs the whole provision
sequence: the job is submitted, the pod runs, the agent answers, files and environment
go in, `uv sync` runs, the kernel is started as the agent's own child and its port is
waited for in-pod, and `exposePort` returns the NodePort address. A warm start takes
about 12 seconds.

The browser reaches the kernel through marimohub's proxy at `/proxy/<token>/...`,
because the NodePort address is on the docker network. The marimo editor loads through
it, websocket included, and autosaves.

When a start fails, the notebook shows a generic "Sandbox compute backend is not
available" with a Retry button; the real error is nested in the server log:

```bash
docker logs marimohub-armada 2>&1 | grep request_error | tail -1 | jq -r '.error.cause.message'
```

The `session_provision` log line reports each step's timing and which succeeded.
marimohub compensates cleanly on a failed start, so Retry is safe.

### Inspecting and tearing down

```bash
./bin/app/armadactl get queues               # queues
./bin/app/armadactl watch <queue> <job-set>  # job events; the job set is the sandbox id
./bin/app/armadactl cancel job-set <queue> <job-set>
kubectl get pods -n armada                   # Armada's own components
kubectl get pods -n default                  # kernel pods
docker logs -f marimohub-armada              # marimohub, including adapter errors
```

Lookout UI: <http://localhost:30000>. To tear down: `docker rm -f marimohub-armada`,
then `make kind-delete-cluster` in armada-operator.

## Changing things

- **Upstream semantics are transcribed, never invented.** marimohub's
  `packages/compute-kubernetes` and `packages/compute-commons` are the reference for
  every sandbox operation, and its compute contract tests are the behavioural
  authority. Check the consumers of a result before choosing its shape.
- **Every design decision goes in ARMADA-REVIEW.md**, numbered, with the evidence
  cited against the Armada source at the release in `.armada-version`. A deliberate
  divergence from upstream is recorded there too. If a decision is superseded, add a
  note at its head and keep the text.
- **Verify live before calling it done.** Unit tests stub the channel; the smoke run
  and a notebook session in a browser are what prove a change against a real Armada.
  Add what you verified to the list in ARMADA-REVIEW.md.
- **Keep the docs current.** `docs/ARCHITECTURE.md` when the shape changes, this
  file when the dev loop changes, the README's configuration table when a variable
  is added.
- **Branch and pull request, squash-merged.** Commit messages are imperative
  summaries of one batch of work.
