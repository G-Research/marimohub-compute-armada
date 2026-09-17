#!/usr/bin/env bash
# Rebuild the adapter and run it on this machine with marimohub's standalone
# Linux binary, against the Armada in the local kind cluster. No marimohub image
# is built and nothing runs under emulation: the host reaches Armada's REST API
# on the port kind maps to localhost and the kernel pods on the docker network
# directly, which Linux routes to. macOS cannot, so use dev/run-local.sh there.
# Assumes Armada is already up (see docs/CONTRIBUTING.md).
#
# The binary is the release matching the Dockerfile's base image, downloaded
# once into dev/bin/ and checked against its published sha256. marimohub runs
# in the foreground with its log on the terminal; Ctrl-C stops it.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=dev/common.sh
. dev/common.sh

if [ "$(uname -s)/$(uname -m)" != "Linux/x86_64" ]; then
	echo "marimohub only publishes a linux-x64 binary; use dev/run-local.sh"
	exit 1
fi

ARMADACTL=${ARMADACTL:-$HOME/Projects/armada-operator/bin/app/armadactl}
QUEUE=${ARMADA_QUEUE:-marimohub}
AGENT_IMAGE=${AGENT_IMAGE:-marimohub-kernel-agent:local}
PORT=${PORT:-3337}
NODE=${NODE:-armada-worker}
DATA=${DATA:-$PWD/dev/data}

# One source of truth for the marimohub release: the image the Dockerfile
# bakes the adapter into, which dependabot keeps current.
VERSION=$(sed -n 's|^FROM ghcr.io/marimo-team/marimohub:\(.*\)$|\1|p' Dockerfile)
[ -n "$VERSION" ] || { echo "cannot read the marimohub version from the Dockerfile"; exit 1; }
BINARY=dev/bin/marimohub-$VERSION-linux-x64

if [ ! -x "$BINARY" ]; then
	echo "==> downloading marimohub $VERSION"
	mkdir -p dev/bin
	base=https://github.com/marimo-team/marimohub/releases/download/v$VERSION
	curl -fsSL -o "$BINARY.tmp" "$base/marimohub-linux-x64"
	curl -fsSL -o "$BINARY.sha256" "$base/marimohub-linux-x64.sha256"
	# The published file names the release's own file name; check our copy.
	echo "$(cut -d' ' -f1 "$BINARY.sha256")  $BINARY.tmp" | sha256sum -c --quiet
	chmod +x "$BINARY.tmp"
	mv "$BINARY.tmp" "$BINARY"
fi

echo "==> building adapter bundle"
bun run build

build_agent_image

ensure_queue

if command -v witr >/dev/null 2>&1 && witr --port "$PORT" >/dev/null 2>&1; then
	echo "==> port $PORT is already in use:"
	witr --port "$PORT"
	exit 1
fi

mkdir -p "$DATA"

# Same settings as dev/run-local.sh: `fs` storage, `dev` auth and `proxy`
# sandbox exposure, so a session behaves the same whichever script started it.
# The proxy is not needed for routing here (the browser could reach the
# NodePort address itself) but it keeps the kernel same-origin with the app.
#
# Under ARMADA_EXPOSE=ingress marimohub must trust the CA dev/ingress-local.sh
# made, named in NODE_EXTRA_CA_CERTS when it exists.
CA=()
if [ -f dev/tls/ca.crt ]; then
	CA=(NODE_EXTRA_CA_CERTS="$PWD/dev/tls/ca.crt")
fi

echo "==> starting marimohub $VERSION on http://localhost:$PORT"
exec env \
	PORT="$PORT" \
	MARIMOHUB_STORAGE_BACKEND=fs \
	MARIMOHUB_STORAGE_FS_ROOT="$DATA" \
	MARIMOHUB_AUTH_BACKEND=dev \
	MARIMOHUB_SANDBOX_EXPOSURE=proxy \
	MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true \
	MARIMOHUB_AUTH_SESSION_SECRET="${MARIMOHUB_AUTH_SESSION_SECRET:-armada-dev-only-proxy-secret}" \
	MARIMOHUB_COMPUTE_BACKEND=library \
	MARIMOHUB_COMPUTE_LIBRARY="$PWD/dist/index.js" \
	MARIMOHUB_COMPUTE_IMAGE=marimo-sandbox:local \
	ARMADA_AGENT_IMAGE="$AGENT_IMAGE" \
	ARMADA_URL="${ARMADA_URL:-http://localhost:30001}" \
	ARMADA_QUEUE="$QUEUE" \
	ARMADA_NAMESPACE="${ARMADA_NAMESPACE:-default}" \
	"${CA[@]}" \
	"$BINARY"
