# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A new version
heading merged to main is released: see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#releasing).

## [Unreleased]

### Fixed

- Startup now also checks the GPU types in `MARIMOHUB_COMPUTE_APP_PROFILES`, the separate
  app profile list from marimohub 0.5.0. An app profile with a GPU type that
  `ARMADA_GPU_NODE_SELECTORS` does not map passed startup and then failed every app
  session that used it.

## [0.1.1] - 2026-10-12

### Fixed

- The kernel agent had no way to report its version. `agent --version` now prints the
  release it was built for, and the agent logs it at startup. A build from
  `agent/Dockerfile` reports `dev` unless it is given `--build-arg VERSION=...`.

## [0.1.0] - 2026-10-12

First release, built and tested against marimohub 0.4.14 and Armada v0.22.7.

### Added

- A marimohub compute adapter that runs notebook kernels as Armada jobs, loaded through
  marimohub's external adapter library mode.
- A kernel agent that runs as PID 1 in the kernel pod and runs the commands marimohub
  sends it, so the adapter needs no Kubernetes credentials. Each pod gets its own token,
  derived from `ARMADA_AGENT_TOKEN_SECRET`.
- The kernel agent as static Linux binaries for amd64 and arm64, with a Dockerfile that
  builds the agent image from them, in the npm package.
- Kernel ports reached through a NodePort or an Ingress (`ARMADA_EXPOSE`).
- `listActive` reconciliation against Lookout (`ARMADA_LOOKOUT_URL`).
- marimohub compute profiles, with GPU types mapped to node selectors
  (`ARMADA_GPU_NODE_SELECTORS`).
- Queues chosen per user or per project (`ARMADA_QUEUE_BY_USER`, `ARMADA_QUEUE_BY_PROJECT`).
- Image pull secrets and a pod security context for private registries and restricted
  clusters.
- Fixed labels and annotations on every kernel pod (`ARMADA_POD_LABELS`,
  `ARMADA_POD_ANNOTATIONS`).
- Basic or bearer token auth to Armada, with the token re-read from a file on every request.
