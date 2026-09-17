#!/usr/bin/env bash
# Rebuild the adapter, bake it into the marimohub image, and run it against the
# Armada in the local kind cluster. Assumes Armada is already up (see docs/CONTRIBUTING.md).
# On a Linux host, dev/run-native.sh does the same without the image.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=dev/common.sh
. dev/common.sh

ARMADACTL=${ARMADACTL:-$HOME/Projects/armada-operator/bin/app/armadactl}
QUEUE=${ARMADA_QUEUE:-marimohub}
IMAGE=${IMAGE:-marimohub-armada:dev}
AGENT_IMAGE=${AGENT_IMAGE:-marimohub-kernel-agent:local}
CONTAINER=${CONTAINER:-marimohub-armada}
PORT=${PORT:-3337}
NODE=${NODE:-armada-worker}

echo "==> building adapter bundle"
bun run build

build_agent_image

echo "==> baking into marimohub image"
docker build --platform linux/amd64 -t "$IMAGE" .

ensure_queue

echo "==> restarting marimohub"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Sandbox exposure is `proxy`: the browser reaches the kernel through the app at
# /proxy/<token>/, and marimohub forwards to the exposePort() URL server-side.
# That is what makes a kernel reachable from a Mac browser at all: the NodePort
# address Armada assigns (172.18.x.x:3xxxx) lives on the docker network, which
# macOS cannot route to, but this container sits on that network and can. The
# ack flag is proxy mode's required opt-in (kernels become same-origin with the
# app), and the session secret signs its routing tokens; both are dev values.
#
# Under ARMADA_EXPOSE=ingress marimohub reaches the kernel and the agent at the
# hostnames Armada reports, so it must trust the CA dev/ingress-local.sh made:
# the file is mounted and named in NODE_EXTRA_CA_CERTS when it exists.
CA_MOUNT=()
if [ -f dev/tls/ca.crt ]; then
	CA_MOUNT=(-v "$PWD/dev/tls/ca.crt:/etc/marimohub/ingress-ca.crt:ro" -e NODE_EXTRA_CA_CERTS=/etc/marimohub/ingress-ca.crt)
fi
docker run -d --name "$CONTAINER" --platform linux/amd64 \
	--network kind \
	-p "$PORT:3000" \
	-v marimohub-armada-data:/data \
	-e MARIMOHUB_STORAGE_BACKEND=fs \
	-e MARIMOHUB_STORAGE_FS_ROOT=/data \
	-e MARIMOHUB_AUTH_BACKEND=dev \
	-e MARIMOHUB_SANDBOX_EXPOSURE=proxy \
	-e MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true \
	-e MARIMOHUB_AUTH_SESSION_SECRET="${MARIMOHUB_AUTH_SESSION_SECRET:-armada-dev-only-proxy-secret}" \
	-e MARIMOHUB_COMPUTE_IMAGE=marimo-sandbox:local \
	-e ARMADA_AGENT_IMAGE="$AGENT_IMAGE" \
	-e ARMADA_URL="${ARMADA_URL:-http://armada-control-plane:30001}" \
	-e ARMADA_QUEUE="$QUEUE" \
	-e ARMADA_NAMESPACE="${ARMADA_NAMESPACE:-default}" \
	${ARMADA_EXPOSE:+-e ARMADA_EXPOSE="$ARMADA_EXPOSE"} \
	${ARMADA_INGRESS_TLS:+-e ARMADA_INGRESS_TLS="$ARMADA_INGRESS_TLS"} \
	${ARMADA_INGRESS_CERT_NAME:+-e ARMADA_INGRESS_CERT_NAME="$ARMADA_INGRESS_CERT_NAME"} \
	${ARMADA_INGRESS_ANNOTATIONS:+-e ARMADA_INGRESS_ANNOTATIONS="$ARMADA_INGRESS_ANNOTATIONS"} \
	${ARMADA_LOOKOUT_URL:+-e ARMADA_LOOKOUT_URL="$ARMADA_LOOKOUT_URL"} \
	${ARMADA_QUEUE_BY_USER:+-e ARMADA_QUEUE_BY_USER="$ARMADA_QUEUE_BY_USER"} \
	${ARMADA_QUEUE_BY_PROJECT:+-e ARMADA_QUEUE_BY_PROJECT="$ARMADA_QUEUE_BY_PROJECT"} \
	${MARIMOHUB_SURFACES:+-e MARIMOHUB_SURFACES="$MARIMOHUB_SURFACES"} \
	"${CA_MOUNT[@]}" \
	"$IMAGE" >/dev/null

echo "==> waiting for marimohub"
for _ in $(seq 1 30); do
	if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
		echo "    ready: http://localhost:$PORT"
		exit 0
	fi
	if [ -z "$(docker ps -q -f name="^${CONTAINER}$")" ]; then
		echo "    container exited:"; docker logs "$CONTAINER" 2>&1 | tail -20; exit 1
	fi
	sleep 2
done

echo "    did not become healthy; logs:"; docker logs "$CONTAINER" 2>&1 | tail -30; exit 1
