# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A new version
heading merged to main is released: see
[docs/CONTRIBUTING.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/CONTRIBUTING.md#releasing).

## [Unreleased]

## [0.5.0] - 2026-11-25

### Added

- On marimohub 0.7.2 and later, the editor's startup screen says where the kernel's Armada
  job is while it waits to run: submitted, waiting in the queue, scheduled, pulling the
  image, running, a preempted pod, and back in the queue after a failed attempt Armada
  retries. The text names no queue, cluster, node or pod. An older marimohub shows its own
  message, as before.
  ([#31](https://github.com/G-Research/marimohub-compute-armada/pull/31))

### Changed

- The Docker image builds on marimohub 0.7.2, and the dev loop runs the matching kernel
  image. The adapter still loads on marimohub 0.7.1.
  ([#31](https://github.com/G-Research/marimohub-compute-armada/pull/31))

## [0.4.0] - 2026-11-19

### Added

- `ARMADA_POD_TEMPLATE_FILE` adds a partial Pod manifest to every kernel pod: volumes of
  any source (CSI, Secret, ConfigMap), the kernel container's `env`, `envFrom` and
  `volumeMounts` (with `subPath`, `readOnly` and `mountPropagation`), and
  `serviceAccountName`, `automountServiceAccountToken` and `enableServiceLinks`. Kernels can
  now mount network shares with a credential from a Secret in the job namespace, and run
  without the namespace's service-account token, or under a service account of their own.
  The file uses the format of marimohub's `MARIMOHUB_COMPUTE_KUBERNETES_POD_TEMPLATE_FILE`,
  where the kernel container is named `marimo`: that name is accepted for the container
  and in a `resourceFieldRef.containerName`, which is submitted as `kernel`.
  Startup fails, naming the field, when the template touches a part of the pod the adapter
  owns, a field another variable sets, or a field it does not support. Without the setting,
  the pod spec is unchanged. The template is part of the submission and so public in
  Lookout, like the rest of the pod spec: it must name Secrets, never hold credentials.
  ([#30](https://github.com/G-Research/marimohub-compute-armada/pull/30))
- The npm package ships the configuration reference, `docs/CONFIGURATION.md`: every
  variable the adapter reads with its default and checks, setups to start from, and what
  a job submission shows everyone in Lookout. It also ships `CHANGELOG.md` and
  `examples/kernel-pod.yaml`, a pod template for network shares with a Kerberos credential
  cache. The README links to it in place of its own configuration section.
  ([#30](https://github.com/G-Research/marimohub-compute-armada/pull/30))

### Changed

- `ARMADA_KERNEL_MAX_LIFETIME_SECONDS` now applies under marimohub. Before, marimohub's
  session lifetime always took its place. Check any value you set: below
  `MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS` it now stops startup, and above it, it now sets
  the pod deadline. Unset, the deadline is twice the session lifetime.
  ([#30](https://github.com/G-Research/marimohub-compute-armada/pull/30))

### Fixed

- Kubernetes killed a kernel pod at marimohub's session lifetime (4 hours by default) even
  when marimohub had extended the session because editors were still connected, and could
  kill an idle session before marimohub saved it. The pod's `activeDeadlineSeconds` is now a
  backstop at twice the session lifetime, as on marimohub's own CoreWeave, E2B and W&B
  backends. `ARMADA_KERNEL_MAX_LIFETIME_SECONDS` sets it instead, and now applies under
  marimohub too: before, marimohub's session lifetime always took its place. A value below
  the session lifetime stops startup. The variable is now documented.
  ([#30](https://github.com/G-Research/marimohub-compute-armada/pull/30))
- `ARMADA_COMMAND_MAX_SECONDS` set but empty turned the exec backstop off, as if it were
  `0`. An empty or blank value of any seconds setting now stops startup, as other empty
  settings already did.
  ([#30](https://github.com/G-Research/marimohub-compute-armada/pull/30))
- `ARMADA_NAMESPACE` or `ARMADA_PRIORITY_CLASS` set but empty was submitted as is, and every
  session failed. Either one set but empty now stops startup.
  ([#30](https://github.com/G-Research/marimohub-compute-armada/pull/30))
- A malformed `ARMADA_POD_ANNOTATIONS`, `ARMADA_POD_LABELS`, `ARMADA_INGRESS_ANNOTATIONS`,
  `ARMADA_QUEUE_BY_*` or `ARMADA_GPU_NODE_SELECTORS` was repeated in full in the startup
  error, where a credential pasted into it would reach marimohub's logs. The error now names
  the variable only.
  ([#30](https://github.com/G-Research/marimohub-compute-armada/pull/30))

## [0.3.0] - 2026-11-18

### Added

- `ARMADA_START_TIMEOUT_SECONDS` sets how long a session start waits for its Armada job to
  run (default 300, as before). The wait was a fixed 5 minutes, and raising marimohub's
  `MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS` did not extend it: marimohub's clock starts
  only once the sandbox is reachable, after the queue wait. A start that runs out now says
  where the job got stuck (still queued, or a pod that will not start) instead of failing
  with a bare `TimeoutError`.
  ([#29](https://github.com/G-Research/marimohub-compute-armada/pull/29))

### Changed

- Needs marimohub 0.7.1 or later, and refuses to load on an older one. Built and tested
  against 0.7.1, which is also the base of the `Dockerfile` image now. From 0.7.1, marimohub
  gives library adapters its own not-found error, and the adapter reports a sandbox whose
  Armada job has finished with it. Before, a notebook whose pod was preempted, cancelled or
  lost stayed locked until an admin reclaimed its session. Because marimohub drops the
  unsaved edits of a sandbox reported gone, the adapter reports it only when Armada confirms
  it: a job Lookout does not list yet is looked for in the job set's events, and a lookup
  Armada cannot answer fails as an ordinary error, which marimohub retries.
  ([#29](https://github.com/G-Research/marimohub-compute-armada/pull/29))

### Fixed

- A session start behind a proxy with a read timeout (nginx's default is 60s) failed once
  its job had waited that long in the queue: the proxy cut the watch for the job to start,
  and a cut watch ended the wait. The wait now opens the stream again after the last event
  it read, through dropped connections and through the 502, 503 or 504 a proxy answers
  meanwhile, until its deadline.
  ([#29](https://github.com/G-Research/marimohub-compute-armada/pull/29))

## [0.2.1] - 2026-11-17

### Fixed

- A sandbox whose Armada job had finished without marimohub asking (preempted, cancelled,
  failed, node lost) still looked alive. Every call to it waited the 30s agent timeout
  against a pod that no longer existed, and each lifecycle sweep took about 90s, which
  delayed snapshots for every session on the hub. The sandbox is now reported gone at once,
  and its calls throw instead of returning `BACKEND_ERROR`.
  ([#28](https://github.com/G-Research/marimohub-compute-armada/pull/28))

## [0.2.0] - 2026-10-13

### Added

- Strict attachment (`connectExisting`), which marimohub uses to save an expired editor
  session's edits before it reclaims the sandbox. It reaches the sandbox's existing job and
  never submits one. Without it, such a session kept its pod and editor claim until its
  authorization ran out or an admin discarded it, and its edits were lost.
  ([#22](https://github.com/G-Research/marimohub-compute-armada/pull/22))

### Changed

- Built and tested against marimohub 0.5.0, which is also the base of the `Dockerfile`
  image now. ([#22](https://github.com/G-Research/marimohub-compute-armada/pull/22))

## [0.1.2] - 2026-10-13

### Fixed

- Startup now also checks the GPU types in `MARIMOHUB_COMPUTE_APP_PROFILES`, the separate
  app profile list from marimohub 0.5.0. An app profile with a GPU type that
  `ARMADA_GPU_NODE_SELECTORS` does not map passed startup and then failed every app
  session that used it. ([#21](https://github.com/G-Research/marimohub-compute-armada/pull/21))

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
