# Architecture

How marimohub reaches a notebook kernel that Armada placed. This is the map; the
reasoning behind each choice, with citations into the Armada source, is in
[DECISIONS.md](DECISIONS.md).

## The three systems

**marimo** is a Python notebook. The process that serves the editor page and runs
the code is one process, the kernel, listening on port 2718.

**marimohub** is a web server that stores notebooks, manages projects and users, and
starts a kernel for a user on demand. It never runs Python itself. When a user opens
a notebook it creates an isolated place for the kernel, the sandbox, puts the files
there and starts the kernel. Where a sandbox runs is a compute adapter's choice, and
this repository is such an adapter, loaded as a library into marimohub's own process.

**Armada** is a batch scheduler above many Kubernetes clusters. A job is a pod
description plus a queue name. Armada decides when and on which cluster it runs, and
an executor in that cluster creates the pod. Armada can also create a service or an
ingress next to the pod and report each port's address in an event. It has no way to
run a command inside a pod, and it exists to keep cluster credentials away from the
tools that use it.

## The shape

```mermaid
flowchart LR
  browser[Browser]
  subgraph hub[marimohub process]
    server[marimohub]
    adapter[this adapter]
  end
  armada[Armada API]
  subgraph cluster[Some worker cluster]
    executor[executor]
    subgraph pod[Kernel pod, one Armada job]
      agent["agent, PID 1, :8718"]
      kernel["marimo, :2718"]
    end
  end
  browser -->|opens a notebook| server
  server -->|create, write, run, read, destroy| adapter
  adapter -->|submit, events, cancel| armada
  armada --> executor
  executor -->|creates| pod
  adapter -->|control channel: commands with a per-session token| agent
  server -->|kernel traffic, proxied| kernel
```

The adapter holds two kinds of address and nothing else: the Armada API, and the
addresses Armada reported in an event for the two ports of one pod. There is no
kubeconfig, no cluster id in use, and no way for marimohub to reach any pod but its
own.

## The two halves of the adapter

**Placement** (`src/armada.ts`) submits one job per kernel session, follows the job
set's event stream until the pod is running, reads the address event, and cancels the
job on destroy. The job's ids are all the sandbox id: `clientId` so a resubmit dedupes,
`jobSetId` so the session has its own event stream, and `externalJobUri` so the job
can be found again. `listActive`, when Lookout is configured, asks Lookout.

Which queue a job goes to is the owner's (`src/queues.ts`): marimohub names the project
and user a sandbox is for, `ARMADA_QUEUE_BY_USER` and `ARMADA_QUEUE_BY_PROJECT` map them
to queues, and the rest go to `ARMADA_QUEUE`. Every later call about a job is addressed
by its queue, and the queue a job is in outranks the map of the day, so the adapter
remembers each sandbox's queue, takes it from Lookout's answer during `listActive`, and
asks Lookout by job set for a sandbox it has never seen; the owner only places a job set
Lookout holds nothing for. A map needs Lookout, and a question Lookout cannot answer
fails the call rather than guess. Every job carries the installation's name (the default
queue) as an annotation, which is what both Lookout queries filter on.

**Control channel** (`src/channel.ts`) is the client for the agent, and the only thing
that reaches into a pod. It has `ready`, which polls the agent's health endpoint until
the route to the pod works; `run` and `stream`, which execute a shell command and
collect or forward its output; and typed operations for the rest: `writeFile`,
`readFile`, `readFileBounded` and `listFiles` carry bytes to and from the agent's
`/files` endpoints, and `startProcess`, `waitForPort`, `processLogs` and
`signalProcess` drive a detached process the agent parents.

`src/sandbox.ts` sits above the channel. Running user code is still a shell command
(`exec`, `execStream`, and the quoted `git clone`), so `src/shell.ts` keeps the env
prefix and quoting for that, transcribed from marimohub's own Kubernetes adapter.
Everything else, files and the kernel's lifecycle, goes to the agent's typed endpoints
rather than through a shell, so no path is quoted and no content is wrapped in base64.
The provider remembers the job, pod and agent channel of every sandbox it has reached,
because marimohub makes a fresh instance for each call and each would otherwise resolve the
pod from the start. A read that fails for any reason but a missing file is the one thing
it logs, because marimohub drops such a file silently and the edits in it are lost
([DECISIONS.md](DECISIONS.md)).

## The agent

Armada has no exec, so the pod brings its own. The kernel container's command is
`/mh-agent/agent --port 8718` instead of `sleep infinity`. An init container from the
agent's own image copies the binary into an `emptyDir` that both containers mount, so
the operator's kernel image is used unchanged and the agent runs with the image's own
`sh`, `PATH`, `uv` and Python.

```mermaid
flowchart LR
  subgraph pod[Kernel pod]
    init["init container, agent image: /agent install /mh-agent/agent"]
    vol[("emptyDir /mh-agent")]
    main["kernel container, operator's image: /mh-agent/agent --port 8718"]
    init --> vol --> main
  end
```

The agent is a Go program with no dependencies, built as one static binary (`agent/`).
It does five things:

- **Runs commands.** `POST /exec` takes `{cmd, stdin, timeoutMs}` and streams NDJSON
  back: the pid, then stdout and stderr chunks as base64, then the exit status. Every
  command starts as the leader of a new session.
- **Runs detached processes.** `/process/{start,status,logs,signal,waitport}` starts a
  process the agent parents, so its liveness and exit code come from a real `wait` and
  its port can be waited for in-pod. This is the kernel's lifecycle. A signal goes to
  the process group, so stopping the kernel takes whatever it spawned with it.
- **Reads and writes files.** `/files` carries bytes raw in the request or response
  body and takes the path as a query parameter, so nothing is quoted for a shell or
  wrapped in base64. `/files/bounded` is the read session capture uses: it refuses a
  symlink anywhere in the path, anything but a regular file, and a file over the
  caller's byte budget, and answers by the caller's deadline.
- **Kills what its caller abandoned and checks the caller.** When a request ends,
  because the caller disconnected or the deadline passed, the agent `SIGTERM`s the
  command's process group and `SIGKILL`s it five seconds later; a Kubernetes exec could
  never do this, and it is why `/exec` streams. Every request carries a bearer token,
  derived from the sandbox id and `ARMADA_AGENT_TOKEN_SECRET` so that any marimohub
  process can reach any pod. The pod spec holds only its SHA-256
  (`MH_AGENT_TOKEN_SHA256`), because the spec is readable through Armada's API and an
  env var is inherited by every process in the pod.
- **Is PID 1.** It reaps orphaned zombies, so a crashed kernel is collected rather
  than left looking alive, and it forwards `SIGTERM` to every process when Kubernetes
  stops the container, inside the pod's grace period.

## One session

```mermaid
sequenceDiagram
  participant H as marimohub
  participant A as adapter
  participant R as Armada API
  participant G as agent (in the pod)
  participant K as marimo (in the pod)
  H->>A: create sandbox, ready()
  A->>A: derive token from the sandbox id, hash it into the pod spec
  A->>R: submit job: two ports, init container, volume
  R-->>A: event: running
  R-->>A: event: address for 2718, address for 8718
  A->>G: GET /healthz until it answers
  H->>A: write notebook files
  A->>G: PUT /files: bytes in the body
  H->>A: run uv sync, start the kernel, wait for the port
  A->>G: POST /exec: uv sync
  A->>G: POST /process/start: sh -lc marimo edit ...
  G->>K: agent parents it, detached from the request
  A->>G: POST /process/waitport: 2718, watching the kernel
  H->>A: exposePort(2718)
  A-->>H: the address Armada reported
  H->>K: kernel traffic while the user works
  H->>A: read files back, destroy
  A->>G: GET /files/bounded: bytes within a budget and a deadline (GET /files up to v0.4.10)
  A->>R: cancel job
```

While the user works, the Armada API and the agent are idle. Only the kernel port
carries traffic.

## Kernel traffic

A pod declares the kernel port, the agent port, and one port per session surface marimohub
has enabled (`MARIMOHUB_SURFACES`: VS Code, OpenCode), and Armada exposes them all the
same way, so `exposePort` answers for any of them from the one address event. That is what
the provider's `multiPort` capability promises, and the agent's port wait can check an
HTTP readiness path rather than a TCP accept, which is what a surface's readiness means.

marimohub has two modes for reaching the kernel. In **proxy** mode the browser talks
to marimohub, which forwards to the address the adapter returned after checking the
user; that is what runs locally, and it is the mode to use first. In **subdomain**
mode the browser connects to the kernel address directly, which needs an ingress with a
hostname on a different domain from marimohub's.

The adapter never templates a hostname. Armada names the host of an ingress rule, and
the adapter returns whatever the address event says: `hostIP:nodePort` for a NodePort
service, the rule host for an ingress. Which of the two the job asks for is
`ARMADA_EXPOSE`, and it covers the agent port and the kernel port together: a NodePort
service is plain HTTP on the cluster network, an Ingress is an HTTPS hostname per port
served by the cluster's ingress controller, with the certificate and the DNS suffix
coming from the executor's configuration rather than from this adapter.

## Two tokens

Every kernel pod has two ports that run code, and each has its own token. They are
easy to confuse, because in `proxy` mode both arrive as `Authorization: Bearer`, but
different code sends each one and different code checks it. A pod with surfaces has
more ports that run code, and those have no token at all (below).

| Port         | Token                                                 | Sent by                                                | Checked by                             | Default                                 |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- | --------------------------------------- |
| 8718, agent  | `HMAC-SHA256(ARMADA_AGENT_TOKEN_SECRET, sandboxId)`   | this adapter                                           | the agent's `authenticated` middleware | always on                               |
| 2718, kernel | 32 random bytes per session, minted by marimohub core | marimohub's proxy (`proxy`), the browser (`subdomain`) | marimo itself                          | off, unless `MARIMOHUB_SANDBOX_AUTH=on` |

```mermaid
sequenceDiagram
  participant B as browser
  participant H as marimohub
  participant A as adapter
  participant G as agent :8718
  participant K as marimo :2718
  participant X as anyone else
  Note over A: agent token = HMAC(secret, sandbox id), the pod spec holds its SHA-256
  Note over H: kernel token = random, per session, with MARIMOHUB_SANDBOX_AUTH=on
  H->>A: write /tmp/.marimohub-kernel-token
  A->>G: PUT /files, Bearer agent token
  G->>G: sha256(token) matches the spec's hash, write the file
  H->>A: start marimo --token-password-file /tmp/.marimohub-kernel-token
  A->>G: POST /process/start, Bearer agent token
  G->>K: start marimo, which reads the kernel token from the file
  B->>H: open the notebook, with the hub login
  H->>H: check the user may attach to this session
  H->>K: forward, Bearer kernel token
  K-->>H: editor
  H-->>B: editor
  X->>G: POST /exec, no token or a wrong one
  G-->>X: 401
  X->>K: GET the kernel, no token or a wrong one
  K-->>X: 401, or a redirect to its login page
```

The diagram shows `proxy` mode. In `subdomain` mode the browser sends the kernel token to
marimo itself. With kernel auth off, marimohub mints no kernel token and marimo starts with
`--no-token`, so the last request in the diagram gets the editor.

**The agent token is ours.** `src/sandbox.ts` derives it, puts only its SHA-256 in the
pod spec as `MH_AGENT_TOKEN_SHA256`, and `src/channel.ts` sends it on every request.
The agent refuses to start without that hash (`agent/main.go`) and wraps every route
but `GET /healthz` in `authenticated` (`agent/server.go`), which hashes the presented
token and compares it in constant time; a missing or wrong token is a 401. The hash in
the spec is not a credential: sent as a token it is hashed again and refused, and the
token behind it is a 256-bit HMAC output, so it cannot be recovered. Whoever holds
`ARMADA_AGENT_TOKEN_SECRET` can compute every sandbox's token.

**The kernel token is marimohub's.** With `MARIMOHUB_SANDBOX_AUTH=on`, marimohub
(0.4.14, `packages/core/src/services/runtime/kernelAuth.ts`) mints a token per session,
keeps it in the session record in its storage, and writes it to
`/tmp/.marimohub-kernel-token` in the pod. For this adapter that write is an ordinary
`PUT /files` to the agent, behind the agent token. marimo starts with
`--token --token-password-file /tmp/.marimohub-kernel-token` and checks every request
itself. In `proxy` mode marimohub adds the token to what it forwards after checking the
user, and strips the `Set-Cookie` marimo answers with, so the browser sees neither. In
`subdomain` mode the token goes into the kernel URL as `?access_token=`, which marimo
exchanges for a session cookie; that cookie is a credential too, since on its own it gets
into the kernel. The agent does not check this token, and none of this repository's code
does. Scheduled jobs get no kernel token, and need none: a job runs `marimo export html`,
which writes a file and serves nothing, so a job's pod declares port 2718 but nothing
listens on it.

**With kernel auth off, the kernel port is open.** marimohub's default is `off`, which
starts marimo with `--no-token` on `0.0.0.0:2718`. Anyone who can reach the address,
including code in another user's notebook on the same cluster network, gets a live
editor in that pod, which is the user's files, environment and a shell. Turn it on in
every deployment. It applies to sessions started after the change.

**The surface ports have no token.** marimohub (0.4.14) starts every surface
`MARIMOHUB_SURFACES` enables on `0.0.0.0` without authentication: openvscode with
`--without-connection-token`, code-server with `--auth none`, and `opencode web` with no
password. This adapter exposes those ports the same way as the kernel port, so each is an
open editor with a terminal for anyone who can reach its address, whatever
`MARIMOHUB_SANDBOX_AUTH` says. Enable surfaces only where the cluster network keeps
everyone but marimohub away from the kernel pods.

**Neither token is encrypted under NodePort.** Both travel as plain HTTP on the cluster
network, so someone who can watch that network can copy either one, or marimo's session
cookie, and use it for the rest of the pod's life. An ingress with TLS encrypts only the
hop to the ingress controller, not the hop from the controller to the pod. The client on
that hop is marimohub, except for the kernel in `subdomain` mode, where it is the browser.

## Abandoned commands

Most of marimohub's calls carry no timeout, and a marimohub restart abandons every
command it had open. The agent handles both: a command dies when its request's context
ends, and a restart is precisely every request ending at once. So an abandoned command
is stopped by the agent killing its process group, with nothing for the adapter to clean
up afterwards.

A command with no caller timeout is sent with `ARMADA_COMMAND_MAX_SECONDS` as its
deadline (default 6 hours, `0` off), so a command nobody is waiting on any more cannot
hold a process for the rest of the session. It is a backstop, not a timeout: the value
is far past anything marimohub's own commands take. Streams are exempt, since how long
one stays open is its reader's decision.

## What the kernel image must provide

`/bin/sh`, so `exec` can run a command, and `git`, for a session that loads from a
repository. That is all: the file and process endpoints are the agent's own code. The
adapter never probes for either; a missing `sh` or `git` surfaces as that command's own
failure. The agent itself needs nothing from the image.

## How the adapter is loaded

There is one process: marimohub's own Node server. At startup it sees
`MARIMOHUB_COMPUTE_BACKEND=library`, imports the bundle named in
`MARIMOHUB_COMPUTE_LIBRARY`, checks the default export is
`{ apiVersion: 1, kind: 'compute' }`, and calls `create(context)`. The provider it gets
back lives on marimohub's heap. Two consequences: a configuration error is a startup
error, and the adapter runs with the server's full privileges.

## Where to look

| Path                  | What it is                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `src/types.ts`        | marimohub's adapter interface, transcribed by hand. Not ours.                  |
| `src/armada.ts`       | Placement: submit, watch, addresses, cancel, `listActive`.                     |
| `src/channel.ts`      | Control channel: the client for the agent's exec, process and file endpoints.  |
| `src/sandbox.ts`      | One kernel session: `exec` on the agent, files and processes on its endpoints. |
| `src/shell.ts`        | Env prefix, quoting and the clone command, from marimohub's `compute-commons`. |
| `src/podspec.ts`      | The pod spec: both containers, both ports, the volume, the hash.               |
| `src/armada-types.ts` | Hand-written Armada wire types, checked against the pinned spec.               |
| `agent/`              | The agent: a Go program run as PID 1 of the kernel container.                  |
