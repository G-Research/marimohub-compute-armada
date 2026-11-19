# Configuring marimohub-compute-armada

The adapter is configured through environment variables of the marimohub process. This
file lists every variable it reads, and ships in the npm package next to the bundle.

All of it is checked when marimohub starts. A missing, malformed or conflicting value stops
startup with an error that names the variable, so a bad setting never waits for the first
session to fail. Error messages name the variable and, where it has one, the field at
fault; for settings that may hold credentials they never repeat the value.

Every variable has an entry under [Reference](#reference), with its heading spelled
exactly as the variable is. Variables that start with `MARIMOHUB_` are marimohub's own; the
adapter reads them too, so they are listed here with what they mean for Armada.

## Loading the adapter

marimohub loads the adapter as an external library. These two are marimohub's settings:

```bash
MARIMOHUB_COMPUTE_BACKEND=library
MARIMOHUB_COMPUTE_LIBRARY=/abs/path/to/node_modules/@gresearch/marimohub-compute-armada/dist/index.js
```

The path must be absolute. The `Dockerfile` in the repository presets both, with the
bundle at `/etc/marimohub/compute.mjs`. The adapter needs marimohub 0.7.1 or later and
refuses to load on an older one.

## Common setups

### The smallest working configuration

Four variables are required. Everything else has a default.

```bash
ARMADA_URL=https://armada.example.com
ARMADA_QUEUE=marimohub
ARMADA_AGENT_IMAGE=registry.example.com/marimohub-kernel-agent:<version>
ARMADA_AGENT_TOKEN_SECRET=<output of openssl rand -hex 32, the same for every hub process>
```

This submits to the `default` namespace, exposes each kernel through a NodePort, which is
plaintext HTTP on the cluster network, and sends no `Authorization` header to Armada. It
suits a local cluster. A local kind cluster with Armada is described in
[docs/CONTRIBUTING.md](https://github.com/G-Research/marimohub-compute-armada/blob/main/docs/CONTRIBUTING.md).

### A production hub

```bash
ARMADA_URL=https://armada.example.com
ARMADA_LOOKOUT_URL=https://lookout.example.com
ARMADA_AUTH_TOKEN_FILE=/var/run/secrets/armada/token
ARMADA_QUEUE=marimohub
ARMADA_NAMESPACE=marimohub-kernels
ARMADA_AGENT_IMAGE=registry.example.com/marimohub-kernel-agent:<version>
ARMADA_AGENT_TOKEN_SECRET=<output of openssl rand -hex 32, the same for every hub process>
ARMADA_IMAGE_PULL_SECRETS=registry-pull
ARMADA_RUN_AS_USER=1000
ARMADA_RUN_AS_GROUP=1000
ARMADA_FS_GROUP=1000
ARMADA_EXPOSE=ingress
ARMADA_INGRESS_ANNOTATIONS='{"nginx.ingress.kubernetes.io/proxy-read-timeout": "3600"}'
ARMADA_START_TIMEOUT_SECONDS=600
MARIMOHUB_SANDBOX_AUTH=on
```

`ARMADA_LOOKOUT_URL` lets marimohub find running sessions again after a restart.
`MARIMOHUB_SANDBOX_AUTH=on` is marimohub's setting: without it, anyone who can reach a
kernel's address has a live editor in that pod. Before going live, read
[What Armada shows everyone](#what-armada-shows-everyone) with whoever sets these values.

### Shared storage, and kernels without the namespace's identity

[`examples/kernel-pod.yaml`](../examples/kernel-pod.yaml), also in the npm package, mounts
network shares through a CSI driver with a Kerberos credential cache from a Secret, and
runs kernels under their own service account with no API token. A CSI driver (Container
Storage Interface) is a storage plugin installed on the cluster's worker nodes: a pod
names it in a `csi` volume, and the driver mounts the storage into the pod.
`kubectl get csidrivers` lists the drivers a cluster has, and every worker cluster Armada
can place a kernel on needs the same one. The example's comments cover the driver's
settings and whether the kernel or the driver authenticates to the shares.

```bash
ARMADA_POD_TEMPLATE_FILE=/etc/marimohub/kernel-pod.yaml
```

See [`ARMADA_POD_TEMPLATE_FILE`](#armada_pod_template_file).

## Reference

| Variable                             | Required | Default                                                       |
| ------------------------------------ | -------- | ------------------------------------------------------------- |
| `ARMADA_URL`                         | yes      |                                                               |
| `ARMADA_QUEUE`                       | yes      |                                                               |
| `ARMADA_AGENT_IMAGE`                 | yes      |                                                               |
| `ARMADA_AGENT_TOKEN_SECRET`          | yes      |                                                               |
| `ARMADA_LOOKOUT_URL`                 | no       | unset: no reconciliation after a restart                      |
| `ARMADA_AUTH_USERNAME`               | no       | unset: no `Authorization` header                              |
| `ARMADA_AUTH_PASSWORD`               | no       | unset                                                         |
| `ARMADA_AUTH_TOKEN`                  | no       | unset                                                         |
| `ARMADA_AUTH_TOKEN_FILE`             | no       | unset                                                         |
| `ARMADA_QUEUE_BY_USER`               | no       | `{}`                                                          |
| `ARMADA_QUEUE_BY_PROJECT`            | no       | `{}`                                                          |
| `ARMADA_NAMESPACE`                   | no       | `default`                                                     |
| `ARMADA_PRIORITY_CLASS`              | no       | the Armada server's default                                   |
| `MARIMOHUB_COMPUTE_IMAGE`            | no       | `ghcr.io/marimo-team/marimo-sandbox:latest`                   |
| `ARMADA_KERNEL_PORT`                 | no       | `2718`                                                        |
| `ARMADA_AGENT_PORT`                  | no       | `8718`                                                        |
| `ARMADA_EXPOSE`                      | no       | `nodeport`                                                    |
| `ARMADA_INGRESS_TLS`                 | no       | `true`                                                        |
| `ARMADA_INGRESS_CERT_NAME`           | no       | Armada's `<namespace>-`                                       |
| `ARMADA_INGRESS_ANNOTATIONS`         | no       | `{}`                                                          |
| `ARMADA_IMAGE_PULL_SECRETS`          | no       | unset: anonymous pulls                                        |
| `ARMADA_RUN_AS_USER`                 | no       | unset: the cluster decides                                    |
| `ARMADA_RUN_AS_GROUP`                | no       | unset                                                         |
| `ARMADA_FS_GROUP`                    | no       | unset                                                         |
| `ARMADA_POD_LABELS`                  | no       | `{}`                                                          |
| `ARMADA_POD_ANNOTATIONS`             | no       | `{}`                                                          |
| `ARMADA_POD_TEMPLATE_FILE`           | no       | unset: nothing added to the pod                               |
| `MARIMOHUB_COMPUTE_PROFILES`         | no       | unset: 1 CPU and `2Gi` per kernel                             |
| `MARIMOHUB_COMPUTE_APP_PROFILES`     | no       | the editing list                                              |
| `ARMADA_GPU_NODE_SELECTORS`          | no       | unset: GPU profiles off                                       |
| `MARIMOHUB_SURFACES`                 | no       | `marimo`: the kernel only                                     |
| `MARIMOHUB_SURFACE_VSCODE_PORT`      | no       | `8443`                                                        |
| `MARIMOHUB_SURFACE_OPENCODE_PORT`    | no       | `4096`                                                        |
| `ARMADA_START_TIMEOUT_SECONDS`       | no       | `300`                                                         |
| `ARMADA_KERNEL_MAX_LIFETIME_SECONDS` | no       | twice marimohub's session lifetime; `86400` without marimohub |
| `ARMADA_COMMAND_MAX_SECONDS`         | no       | `21600`                                                       |
| `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME` | no       | no effect with this adapter                                   |

### Armada and Lookout

#### `ARMADA_URL`

The base URL of Armada's REST API, `http` or `https`. Anything else stops startup.

#### `ARMADA_LOOKOUT_URL`

The base URL of Lookout, `http` or `https`. Armada's own API cannot list the jobs one
client owns, and Lookout aggregates jobs across every executor cluster, so with it set the
adapter advertises `listActive`: marimohub's reconciler then finds the sessions still
running after a restart. Without it, reconciliation is a clean no-op. It is required when
[`ARMADA_QUEUE_BY_USER` or `ARMADA_QUEUE_BY_PROJECT`](#armada_queue_by_user-and-armada_queue_by_project)
name a queue other than `ARMADA_QUEUE`.

#### `ARMADA_AUTH_USERNAME` and `ARMADA_AUTH_PASSWORD`

Basic auth to Armada and Lookout. Set both or neither.

#### `ARMADA_AUTH_TOKEN`

A bearer token, for example from OIDC, sent as is (trimmed) on every request.

#### `ARMADA_AUTH_TOKEN_FILE`

A file that holds a bearer token. It is read at startup, so a missing or empty file stops
marimohub, and again on every request, so a token that rotates on disk is picked up
without a restart. Prefer it for anything that rotates.

Configure at most one of the three mechanisms; two stop startup. With none, no
`Authorization` header is sent, which is what a server with `anonymousAuth: true` expects.
Auth credentials only ever travel in that header, never in a job submission.

### Queues, namespace and priority

#### `ARMADA_QUEUE`

The Armada queue every sandbox goes to, unless its owner maps elsewhere. The queue must
exist, with permission for the configured credential to submit to it.

#### `ARMADA_QUEUE_BY_USER` and `ARMADA_QUEUE_BY_PROJECT`

JSON objects of marimohub user id, and project id, to queue name. Armada computes fair
share and priority per queue, so a queue per team or user is how tenants are told apart.
The user's entry wins over the project's. Every queue named must already exist.

```bash
ARMADA_QUEUE_BY_PROJECT='{"proj-risk": "risk", "proj-research": "research"}'
ARMADA_QUEUE_BY_USER='{"user-alice": "research-priority"}'
```

The owner places a sandbox that does not exist yet. For one that does, the queue it is in
is the answer, whatever the map says today: the adapter remembers it, learns it from
Lookout during `listActive`, and asks Lookout for a sandbox it has never seen, since
marimohub addresses sandboxes by id alone on several paths. So a map that names any queue
other than `ARMADA_QUEUE` requires `ARMADA_LOOKOUT_URL`, and a call Lookout cannot answer
fails rather than guesses; marimohub retries it.

#### `ARMADA_NAMESPACE`

The Kubernetes namespace the executor creates kernel pods in. Every Secret, ConfigMap and
service account the other settings name must be in this namespace.

#### `ARMADA_PRIORITY_CLASS`

An Armada priority class, not a Kubernetes one. It must be in the server's
`allowedPriorityClassNames`. Unset, jobs get the server's default, which ships as
`armada-default` and is not preemptible. Only choose one that is at least as protected:
a preempted kernel loses the session.

### Images and the agent

#### `MARIMOHUB_COMPUTE_IMAGE`

marimohub's comma-separated list of kernel images. The first is the default, and a
kernel runs whichever image of the list marimohub asks for. Unset, it is
`ghcr.io/marimo-team/marimo-sandbox:latest`, marimo's own kernel image, public and amd64
only, with `latest-vscode`, `latest-opencode` and `latest-tools` variants for
[surfaces](#marimohub_surfaces). Set but empty stops startup. Use your own build of
marimohub's `examples/sandbox-image` when the nodes are arm64, cannot reach the internet,
or need a pinned marimo.

#### `ARMADA_AGENT_IMAGE`

The image of the kernel agent, which an init container copies into every kernel pod.
Required: no image is published. Build it from the npm package's `dist/agent` (see the
README's "From the npm package") and push it where the worker clusters pull from. Tag it
with the package version and upgrade both together: a newer adapter can call an agent
route an older agent lacks.

#### `ARMADA_AGENT_TOKEN_SECRET`

The key each sandbox's agent token is derived from, with the sandbox id. At least 32
characters; `openssl rand -hex 32` prints 64. Every marimohub process running the adapter
must have the same value, since marimohub stops and snapshots a session through whichever
process gets there, and a process with another secret is refused by the pod. Changing it
cuts every running session off from its agent, so their unsaved edits are lost: rotate it
when no sessions are running. Only a SHA-256 of each derived token reaches the pod spec.

#### `ARMADA_KERNEL_PORT`

The port marimo serves on inside the pod, 1 to 65535.

#### `ARMADA_AGENT_PORT`

The port the agent listens on inside the pod, 1 to 65535. It must differ from the kernel
port and from every surface port. It is exposed exactly as the kernel port is, so
whatever reaches one reaches the other.

### Exposure

#### `ARMADA_EXPOSE`

How the kernel, agent and surface ports are reached from marimohub: `nodeport` or
`ingress`.

- `nodeport` asks Armada for a NodePort service. Each port is reached as
  `hostIP:nodePort`, plaintext HTTP on the cluster's own network. It is what a local
  cluster offers with nothing installed, and is enough when marimohub runs beside the
  cluster in `proxy` exposure.
- `ingress` asks for an Ingress: one hostname per port, named by the executor's
  `podDefaults.ingress.hostnameSuffix`, served by the cluster's ingress controller.
  Armada's Ingress names no class, so the cluster needs a default IngressClass or an
  annotation naming one. The executor's suffix must be a wildcard DNS record for the
  controller.

The `ARMADA_INGRESS_*` variables only apply with `ingress`; set beside `nodeport`, they stop
startup.

#### `ARMADA_INGRESS_TLS`

`true` or `false`, for `ingress` only. With `true` the URLs are `https`, and the Ingress
names a TLS secret: Armada's `<namespace>-`, or
[`ARMADA_INGRESS_CERT_NAME`](#armada_ingress_cert_name), with the executor's
`certNameSuffix` appended. That secret must hold a wildcard certificate for
`*.<namespace>.<suffix>` that marimohub trusts (`NODE_EXTRA_CA_CERTS` for a private CA).
The controller forwards to the pod in plaintext either way.

#### `ARMADA_INGRESS_CERT_NAME`

The TLS secret name prefix, for `ingress` only, in place of Armada's `<namespace>-`.

#### `ARMADA_INGRESS_ANNOTATIONS`

A JSON object of annotations put on every job's Ingress, on top of the executor's
cluster-wide ones, for `ingress` only. A longer websocket read timeout, or a source
allowlist that lets only marimohub's egress address reach the agent, go here. Values must
be non-empty strings. They are public in Lookout: name a Kubernetes Secret
(`nginx.ingress.kubernetes.io/auth-secret`), never put a credential in one.

```bash
ARMADA_INGRESS_ANNOTATIONS='{"nginx.ingress.kubernetes.io/proxy-read-timeout": "3600", "nginx.ingress.kubernetes.io/whitelist-source-range": "10.0.0.5/32"}'
```

### The kernel pod

#### `ARMADA_IMAGE_PULL_SECRETS`

Comma-separated names of Secrets in `ARMADA_NAMESPACE`, listed as `imagePullSecrets` on
every pod. The worker cluster pulls both the kernel and the agent image, never marimohub,
so a private registry needs a credential the cluster holds. A secret's registry host must
match the image's host exactly (`ghcr.io` is not `https://ghcr.io/v2/`); a mismatch shows
later as `ImagePullBackOff`, not at startup. Set but naming nothing stops startup.

#### `ARMADA_RUN_AS_USER`, `ARMADA_RUN_AS_GROUP` and `ARMADA_FS_GROUP`

Whole numbers, `0` or more, for the pod-level `securityContext` (`runAsUser`,
`runAsGroup`, `fsGroup`). For a cluster whose admission policy rejects a pod that does not
say who it runs as (`runAsUser not specified`). Pod-level, so the init container that
copies the agent runs with the same ids as the kernel. None has a default: which uid a
kernel image tolerates is a property of that image.

Set `ARMADA_FS_GROUP` with a non-root `ARMADA_RUN_AS_USER`. The agent's volume is an
`emptyDir`, mounted root-owned, and only `fsGroup` makes it writable for a non-root user.
Without it, the init container fails with a permission error before the kernel starts.

#### `ARMADA_POD_LABELS` and `ARMADA_POD_ANNOTATIONS`

JSON objects of fixed labels and annotations for every kernel pod, for cost allocation,
admission policies or `kubectl -l`. Armada copies them onto the pod; the pod's Service and
Ingress do not get them. Armada does not check them at submit, so the adapter applies
Kubernetes' rules at startup: an invalid key or label value stops startup. Keys starting
with `armada_` or `armadaproject.io/`, and `marimohub/sandbox`, are reserved. Both are
public in Lookout.

```bash
ARMADA_POD_LABELS='{"team": "quant", "example.com/cost-center": "cc-1234"}'
ARMADA_POD_ANNOTATIONS='{"example.com/contact": "quant@example.com"}'
```

#### `ARMADA_POD_TEMPLATE_FILE`

The path of a partial Pod manifest, YAML or JSON, read once at startup and added to every
kernel pod. A change to the file applies after a restart, to new sessions. The format is
the one marimohub's Kubernetes backend reads from
`MARIMOHUB_COMPUTE_KUBERNETES_POD_TEMPLATE_FILE`, and the kernel container may be named
`kernel` or `marimo`, so a template written for that backend works here unchanged as long
as it uses only these fields:

| Field                               | What it does                                                 |
| ----------------------------------- | ------------------------------------------------------------ |
| `spec.volumes`                      | Volumes of any source (CSI, Secret, ConfigMap, ...), by name |
| `spec.containers[0].volumeMounts`   | `mountPath`, `readOnly`, `subPath(Expr)`, `mountPropagation` |
| `spec.containers[0].env`            | A `value`, or `valueFrom` a Secret, ConfigMap or field       |
| `spec.containers[0].envFrom`        | Every key of a Secret or ConfigMap, by name                  |
| `spec.serviceAccountName`           | The service account kernel pods run as                       |
| `spec.automountServiceAccountToken` | `false` keeps the API token out of the pod                   |
| `spec.enableServiceLinks`           | `false` keeps the namespace's Service variables out          |

[`examples/kernel-pod.yaml`](../examples/kernel-pod.yaml) is a complete template: network
shares through a CSI driver, a Kerberos configuration and credential cache from Secrets,
and a service account of the kernels' own.

Kernel pods run user code. Without a template they run as the namespace's `default`
service account, with its API token mounted at
`/var/run/secrets/kubernetes.io/serviceaccount/`, so every notebook can read that token.
Set `automountServiceAccountToken: false` to stop that, and `serviceAccountName` to give
kernels an identity of their own, apart from the hub's. Armada does not check either at
submit: a service account that does not exist in `ARMADA_NAMESPACE` fails the pod, and the
session start fails with that event.

Mount a Secret that is renewed, like a credential cache, without `subPath`: Kubernetes
updates a Secret volume in place, but never a `subPath` mount of one.

The template adds to the pod and replaces nothing. Its volumes, mounts and variables come
after the adapter's own. Startup fails, naming `ARMADA_POD_TEMPLATE_FILE` and the field,
when the template:

- touches a part the adapter owns: the `mh-agent` volume, a mount at or under
  `/mh-agent`, the `MH_AGENT_TOKEN_SHA256` variable, the container's `image`, `command`,
  `args`, `ports` or `resources`, init containers, a second container, or the restart
  policy, grace period or deadline;
- sets a field another variable sets: `imagePullSecrets`
  ([`ARMADA_IMAGE_PULL_SECRETS`](#armada_image_pull_secrets)), `securityContext`
  ([`ARMADA_RUN_AS_USER`](#armada_run_as_user-armada_run_as_group-and-armada_fs_group)),
  `nodeSelector` ([`ARMADA_GPU_NODE_SELECTORS`](#armada_gpu_node_selectors)),
  `priorityClassName` ([`ARMADA_PRIORITY_CLASS`](#armada_priority_class)), or pod
  `metadata` ([`ARMADA_POD_LABELS`](#armada_pod_labels-and-armada_pod_annotations));
- uses any field not in the table above;
- mounts a volume it does not define, or has two volumes, mounts or variables with one
  name;
- is not one YAML or JSON document.

YAML is read as 1.1, as Kubernetes manifests are, so `defaultMode: 0444` is octal. Quote a
value such as `"true"` or `"123"` that must stay a string.

The template is part of the submission, so everyone with Lookout access reads it, for good
(see [What Armada shows everyone](#what-armada-shows-everyone)). Name things in it: a Secret
by name, a key in it, a path. Never put a credential in it, above all not as an `env`
`value`, which is copied into the pod spec as written; take a secret value `valueFrom` a
`secretKeyRef` instead.

### Compute profiles and GPUs

#### `MARIMOHUB_COMPUTE_PROFILES`

marimohub's list of compute profiles, which let editors pick hardware per notebook. A
profile's CPU and memory become the kernel container's requests and limits, which Armada
requires to be equal. So a kernel that outgrows its memory is OOM-killed, and every session
is charged its full profile against the queue's fair share, idle or not: offer a short list
of sizes rather than one large default. Without profiles, a kernel gets 1 CPU and `2Gi`.
Users can only pick when marimohub's `MARIMOHUB_COMPUTE_PROFILE_OVERRIDE=editors`.

```bash
MARIMOHUB_COMPUTE_PROFILES='small:cpu=1;mem=4Gi,large:cpu=4;mem=32Gi,a100:cpu=8;mem=64Gi;gpu=A100'
MARIMOHUB_COMPUTE_PROFILE_OVERRIDE=editors
ARMADA_GPU_NODE_SELECTORS='{"A100": {"nvidia.com/gpu.product": "NVIDIA-A100-SXM4-80GB"}}'
```

The adapter reads the list only for the GPU types it names, which
[`ARMADA_GPU_NODE_SELECTORS`](#armada_gpu_node_selectors) must map.

#### `MARIMOHUB_COMPUTE_APP_PROFILES`

marimohub's separate profile list for apps, in the same syntax. Without it, apps use the
editing list. Its GPU types must be mapped too.

#### `ARMADA_GPU_NODE_SELECTORS`

A JSON object of GPU type, as the profiles name it, to the `nodeSelector` that puts a pod
on a node with that GPU. A profile's GPU count becomes an `nvidia.com/gpu` request, and its
type becomes this selector. GPU profiles are only on when this is set: without it,
marimohub drops the GPUs from every profile and says so at startup. With it, a profile
whose type it does not map stops startup. Types are matched case-insensitively.

The label values are the cluster's (`kubectl get nodes -L nvidia.com/gpu.product`), and
every label used must be in each executor's `kubernetes.trackedNodeLabels`: the scheduler
only sees tracked labels, so a selector on any other stays queued for good.

### Surfaces

#### `MARIMOHUB_SURFACES`

marimohub's comma-separated list of session surfaces: `marimo`, the kernel itself, plus
`vscode` or `opencode`. Each surface after the kernel needs a port of its own, which the
adapter declares on every pod so Armada exposes it like the kernel's; it then advertises
`multiPort`. A surface this adapter does not know stops startup. The kernel image must ship
the surface's binary (marimo's `latest-vscode` and `latest-opencode` images do). Surfaces
have no token: anyone who can reach a surface's address can use it, so enable them only
where the network keeps everyone but marimohub away from the kernel pods.

#### `MARIMOHUB_SURFACE_VSCODE_PORT`

The VS Code surface's port, when `vscode` is enabled. It may not be the kernel's or the
agent's port.

#### `MARIMOHUB_SURFACE_OPENCODE_PORT`

The OpenCode surface's port, when `opencode` is enabled. It may not be the kernel's or the
agent's port.

### Time limits

#### `ARMADA_START_TIMEOUT_SECONDS`

How long a session start waits for its job to run, in whole seconds, at least 1. It covers
the time in the Armada queue, scheduling, the image pull and the agent's init container.
A start that runs out fails with the last event the job reported, which tells a job still
queued from a pod that will not start. Raise it on a busy cluster.

marimohub's own clocks sit around it:

- `MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS` (marimohub's default 120) starts only once
  the pod answers, and covers installing the notebook's dependencies and starting marimo.
  It does not extend the queue wait.
- The browser tab that started a session times out after 150 seconds while the server goes
  on waiting. marimohub fixes that limit; no setting changes it.
- A tab that picks up a session already starting (a reload, a second tab) gives up after
  `MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS` plus 30 seconds, so keep that at least as long
  as a typical queue wait.
- marimohub marks a session still starting after 15 minutes as failed. Keep this value
  plus `MARIMOHUB_SANDBOX_STARTUP_TIMEOUT_SECONDS` plus about 90 seconds below that.

#### `ARMADA_KERNEL_MAX_LIFETIME_SECONDS`

The hard cap on one kernel pod, in whole seconds, submitted as its `activeDeadlineSeconds`.
Kubernetes kills the pod at this deadline without a save, so it is only a backstop for a
pod marimohub has lost track of. Session length is marimohub's to decide, with its
`MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS` (default `14400`, 4 hours): at that deadline
marimohub moves it 30 minutes on while editors are connected
(`MARIMOHUB_SESSION_LIFETIME_EXTENSION_SECONDS`), and otherwise saves the notebook and
ends the session.

Unset, the deadline is twice marimohub's session lifetime, 8 hours by default, as on
marimohub's own CoreWeave, E2B and W&B backends. A session still being edited at that
point is ended without a save, so raise `MARIMOHUB_SESSION_MAX_LIFETIME_SECONDS`, or set
this, if sessions run longer. A value below the session lifetime stops startup: it would
kill sessions before marimohub saves them. Without marimohub (the smoke test) the default
is `86400`. Every pod carries a deadline, because without one Armada gives it the server
default, 72 hours as shipped.

#### `ARMADA_COMMAND_MAX_SECONDS`

A backstop for one command marimohub runs in the kernel, in whole seconds; `0` turns it
off. Not a timeout: marimohub's own commands carry their own, and many deliberately carry
none, because unpacking a workspace takes minutes. This catches a command still running
hours after anyone expected it. Streams are exempt.

### Ignored

#### `MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME`

marimohub's setting for a public kernel hostname. It has no effect with this adapter:
Armada names each kernel's address, through the NodePort or the executor's ingress
hostname suffix.

## What Armada shows everyone

Armada keeps every job submission and serves it back whole: its API returns the pod spec,
and Lookout shows the submission to everyone who can open the job. Once submitted, nothing
takes it back. Treat every value below as readable by everyone with Lookout access, for
good, and never put a credential in one. The two tables are the whole submission.

What configuration decides:

| In the submission       | Comes from                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Queue and namespace     | `ARMADA_QUEUE` (or the owner's entry in `ARMADA_QUEUE_BY_*`), `ARMADA_NAMESPACE`                       |
| Kernel and agent images | `MARIMOHUB_COMPUTE_IMAGE` (the one marimohub asks for), `ARMADA_AGENT_IMAGE`                           |
| Pod labels              | `ARMADA_POD_LABELS`                                                                                    |
| Pod annotations         | `ARMADA_POD_ANNOTATIONS`                                                                               |
| Exposure                | `ARMADA_EXPOSE`: a NodePort service or an Ingress                                                      |
| Ingress settings        | `ARMADA_INGRESS_TLS`, `ARMADA_INGRESS_CERT_NAME`, `ARMADA_INGRESS_ANNOTATIONS`                         |
| Ports                   | `ARMADA_KERNEL_PORT`, `ARMADA_AGENT_PORT`, `MARIMOHUB_SURFACE_<ID>_PORT`                               |
| Surfaces                | `MARIMOHUB_SURFACES`, which picks the surfaces whose ports are declared                                |
| Resources               | The compute profile's CPU, memory and GPU count, else 1 CPU and `2Gi`                                  |
| Node selector           | `ARMADA_GPU_NODE_SELECTORS`, the entry for the profile's GPU type                                      |
| Priority class          | `ARMADA_PRIORITY_CLASS`                                                                                |
| Pull secrets            | `ARMADA_IMAGE_PULL_SECRETS`, the secret names only                                                     |
| Pod security context    | `ARMADA_RUN_AS_USER`, `ARMADA_RUN_AS_GROUP`, `ARMADA_FS_GROUP`                                         |
| Extra volumes           | `ARMADA_POD_TEMPLATE_FILE`, `spec.volumes`, with every Secret by name                                  |
| Kernel mounts and env   | `ARMADA_POD_TEMPLATE_FILE`, the kernel container's `volumeMounts`, `env(From)`                         |
| Service account         | `ARMADA_POD_TEMPLATE_FILE`, `serviceAccountName`, `automountServiceAccountToken`, `enableServiceLinks` |
| Deadline                | `ARMADA_KERNEL_MAX_LIFETIME_SECONDS`, else twice marimohub's session lifetime                          |

What the adapter fixes:

| In the submission                       | Value                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Job set id, client id, external job URI | The sandbox id                                                            |
| Annotations                             | `armadaproject.io/failFast: "true"`, `marimohub/sandbox` set to the queue |
| One pod environment variable            | `MH_AGENT_TOKEN_SHA256`, the SHA-256 of the agent token, never the token  |
| Pod lifecycle                           | Restart policy `Never`, a 30s grace period                                |
| Agent install                           | The `mh-agent` volume and the init container that copies the agent in     |
| Init container resources                | `100m` CPU and `64Mi` memory                                              |
| Container commands                      | `/agent install …` and `/mh-agent/agent --port <ARMADA_AGENT_PORT>`       |
| Ingress service                         | `useClusterIP: true`                                                      |

Every configured value is copied in as written. The adapter checks each one's shape, such
as a valid label key or a nonblank name, and nothing more: it cannot tell a credential from
any other string. The free-form values are where one is most likely to be pasted:
`ARMADA_POD_ANNOTATIONS`, `ARMADA_INGRESS_ANNOTATIONS`, the `env` values and CSI
`volumeAttributes` in `ARMADA_POD_TEMPLATE_FILE`, and `ARMADA_POD_LABELS` within the label
character set. Some ingress annotations invite a credential: an ingress-nginx
`configuration-snippet` that sets an `Authorization` header, or an `auth-url` with a key in
its query string. Name a Kubernetes Secret instead (`nginx.ingress.kubernetes.io/auth-secret`),
the way `ARMADA_IMAGE_PULL_SECRETS` does for registries.

`ARMADA_POD_TEMPLATE_FILE` is the one setting that puts environment variables on the pod,
and its whole file is in the spec. A variable's `value` is copied as written, so it is for
paths and names such as `KRB5CCNAME`. A secret goes in a Kubernetes Secret, which the
template names (`valueFrom.secretKeyRef`, `envFrom.secretRef`, a `secret` volume), and only
the name reaches the submission. `ARMADA_AGENT_TOKEN_SECRET`, the agent tokens and the
`ARMADA_AUTH_*` credentials never enter a submission.

Notebook users cannot put anything in a submission: they pick a compute profile and an
image from lists the operator wrote. The credentials they give marimohub for an
integration, such as a database password or a cloud key, become the session's environment,
which the adapter hands to the pod through the agent, as `export` statements in front of
each command. So those credentials:

- stay out of the submission and out of Lookout;
- cross the cluster network as plain HTTP, readable by anyone who can watch it. The agent
  speaks only HTTP, so under `ARMADA_EXPOSE=nodeport` the whole way is plaintext, and
  under `ingress` with TLS only the hop from marimohub to the ingress controller is
  encrypted: the controller forwards to the pod in plaintext;
- are visible to every process in the kernel container, as on any marimohub backend;
- never appear in the adapter's own error messages. Those name the command marimohub
  asked for at most, never the `export` statements put in front of it, so a credential
  written into the command itself would still show.

What a notebook prints stays out of Lookout as well. The kernel's output goes to a log file
inside the pod and command output goes back over the agent, so the container log, which is
what Lookout's log view shows, holds only the agent's own lines.

Before a deployment goes live, walk whoever sets these variables through this section. The
adapter keeps the credentials it handles out of the submission; it cannot stop a person
typing one into a variable that is public by design.
