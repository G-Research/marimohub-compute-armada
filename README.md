# marimohub-compute-armada

A [marimohub](https://github.com/marimo-team/marimohub) compute adapter that runs
notebook kernels as [Armada](https://armadaproject.io/) jobs.

Loaded through marimohub's external adapter library mode (`apiVersion: 1`), so it
needs no changes to marimohub itself.

## Status

Released on npm as
[`@gresearch/marimohub-compute-armada`](https://www.npmjs.com/package/@gresearch/marimohub-compute-armada):
the adapter bundle, and the kernel agent as static Linux binaries for amd64 and arm64 with a
Dockerfile that turns them into the agent image. No image is published; the agent image goes
into a registry your worker clusters pull from, built from the package without a Go
toolchain (see [From the npm package](#from-the-npm-package)). Each release is also a GitHub
release with the same files and build attestations; [CHANGELOG.md](CHANGELOG.md) lists what
changed.

To build from source instead, see [Deployment](#deployment);
[docs/CONTRIBUTING.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/CONTRIBUTING.md) walks through a full run against a local kind
cluster.

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
in [docs/ARCHITECTURE.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/ARCHITECTURE.md).

## Configuration

The adapter is configured through environment variables, all of them checked when
marimohub starts. **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** is the reference:
every variable, its default and its checks, setups to start from, and what Armada shows
everyone with Lookout access. It ships in the npm package, at
`node_modules/@gresearch/marimohub-compute-armada/docs/CONFIGURATION.md`, with an example
pod template in `examples/`.

Four variables are required:

```bash
ARMADA_URL=https://armada.example.com
ARMADA_QUEUE=marimohub
ARMADA_AGENT_IMAGE=registry.example.com/marimohub-kernel-agent:<version>
ARMADA_AGENT_TOKEN_SECRET=<output of openssl rand -hex 32, the same for every hub process>
```

Everything in a job submission, the pod spec included, is readable by everyone with
Lookout access, for good. No setting may hold a credential: name a Kubernetes Secret
instead. See
[What Armada shows everyone](docs/CONFIGURATION.md#what-armada-shows-everyone).

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

The kernel port is not guarded by the agent token. marimo checks a token of its own,
which marimohub mints per session, and only when `MARIMOHUB_SANDBOX_AUTH=on`. Its default
is `off`, which starts marimo with `--no-token`: anyone who can reach a kernel's address
then has a live editor in that pod. Set `MARIMOHUB_SANDBOX_AUTH=on`, as both scripts in
`dev/` do. [ARCHITECTURE.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/ARCHITECTURE.md#two-tokens) explains which code sends and
checks each token.

The surface ports (`MARIMOHUB_SURFACES`) have no token under either setting: marimohub starts
VS Code and OpenCode without authentication, so each one is open to anyone who can reach its
address. Enable surfaces only where the cluster network keeps everyone but marimohub away
from the kernel pods.

### From the npm package

The package carries everything this adapter adds: `dist/index.js`, the bundle marimohub
loads, and `dist/agent`, the agent for both worker architectures with its Dockerfile and
checksums. Install it anywhere; nothing in it runs on install.

```bash
npm install --prefix /opt/marimohub-armada @gresearch/marimohub-compute-armada@<version>
PKG=/opt/marimohub-armada/node_modules/@gresearch/marimohub-compute-armada

# The agent image, into a registry the worker clusters pull from. Nothing runs in the
# build, so either architecture builds on any host without emulation.
docker buildx build --platform linux/amd64,linux/arm64 --push \
  -t <registry>/marimohub-kernel-agent:<version> "$PKG/dist/agent"
export ARMADA_AGENT_IMAGE=<registry>/marimohub-kernel-agent:<version>

# The adapter, from where it was installed, or copied into the marimohub image as the
# Dockerfile does.
export MARIMOHUB_COMPUTE_LIBRARY="$PKG/dist/index.js"
```

Tag the agent image with the package version and upgrade both together: an adapter can
call an agent route that an older agent does not have. To check where the files came from,
`npm audit signatures` verifies the package's provenance, and
`gh attestation verify "$PKG/dist/agent/linux-amd64/agent" --repo G-Research/marimohub-compute-armada`
verifies a binary against the attestation of the release that built it.

### Without the marimohub image

Each marimohub release also ships `marimohub-linux-x64`, a standalone server binary for
x86-64 Linux hosts with no Node installed. It loads the adapter the same way the image
does, so the Dockerfile is optional: put the bundle somewhere on the host and point the
binary at it. The agent image is still needed, since it runs in the cluster.

```bash
# The bundle: one self-contained file, built with `bun run build`.
sudo install -D dist/index.js /etc/marimohub/compute.mjs

# The binary, at the release the Dockerfile names, checked against its published hash.
V=0.7.2
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
[docs/CONTRIBUTING.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/CONTRIBUTING.md), which also covers the case where
`kind load` trips over a multi-platform image.

Needs marimohub 0.7.1 or later, and is built and tested against the release in the
`Dockerfile`. An older marimohub gives library adapters no `errors.notFound`, which the
adapter reports a lost pod with, so the adapter refuses to load there.

## Documentation

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every setting, with examples, and what a
  job submission shows everyone.
- [docs/ARCHITECTURE.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/ARCHITECTURE.md): the three systems, the agent, and
  how one session flows through them.
- [docs/CONTRIBUTING.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/CONTRIBUTING.md): toolchain, checks, running the whole
  thing locally, and what to update when you change something.
- [docs/DECISIONS.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/DECISIONS.md): why the adapter is shaped the way it is, with
  the evidence cited against the pinned Armada release, and what is left to a deployment.

## License

Copyright 2026 G-Research. Apache-2.0, see [LICENSE](LICENSE).
