#!/usr/bin/env bash
# Rebuild the adapter, bake it into the marimohub image, and run it against the
# Armada in the local kind cluster. Assumes Armada is already up (see README.md).
set -euo pipefail

cd "$(dirname "$0")/.."

ARMADACTL=${ARMADACTL:-$HOME/Projects/armada-operator/bin/app/armadactl}
KIND=${KIND:-$HOME/Projects/armada-operator/bin/tooling/kind}
QUEUE=${ARMADA_QUEUE:-marimohub}
IMAGE=${IMAGE:-marimohub-armada:dev}
CONTAINER=${CONTAINER:-marimohub-armada}
PORT=${PORT:-3000}
KUBECONFIG_FILE=dev/kubeconfig-internal.yaml

echo "==> building adapter bundle"
bun run build

# The control channel execs into pods through the cluster's API server, and the
# container cannot use ~/.kube/config: that config says https://127.0.0.1:<port>,
# which inside a container is the container. The internal variant says
# https://armada-control-plane:6443, reachable once the container joins the kind
# docker network, and that name is in the API server certificate's SANs
# (host.docker.internal is not, so rewriting the server URL would fail TLS).
echo "==> writing internal kubeconfig for the control channel"
"$KIND" get kubeconfig --internal --name armada >"$KUBECONFIG_FILE"

echo "==> baking into marimohub image"
docker build --platform linux/amd64 -t "$IMAGE" .

echo "==> ensuring Armada queue '$QUEUE' exists"
if ! queue_out=$("$ARMADACTL" create queue "$QUEUE" 2>&1); then
	# Only an existing queue is benign; anything else (missing binary, auth) is fatal.
	case "$queue_out" in
	*"already exists"*) ;;
	*)
		echo "$queue_out"
		exit 1
		;;
	esac
fi

echo "==> restarting marimohub"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Sandbox exposure is `proxy`: the browser reaches the kernel through the app at
# /proxy/<token>/, and marimohub forwards to the exposePort() URL server-side.
# That is what makes a kernel reachable from a Mac browser at all: the NodePort
# address Armada assigns (172.18.x.x:3xxxx) lives on the docker network, which
# macOS cannot route to, but this container sits on that network and can. The
# ack flag is proxy mode's required opt-in (kernels become same-origin with the
# app), and the session secret signs its routing tokens; both are dev values.
docker run -d --name "$CONTAINER" --platform linux/amd64 \
	--network kind \
	-p "$PORT:3000" \
	-v marimohub-armada-data:/data \
	-v "$PWD/$KUBECONFIG_FILE":/etc/marimohub/kubeconfig:ro \
	-e MARIMOHUB_STORAGE_BACKEND=fs \
	-e MARIMOHUB_STORAGE_FS_ROOT=/data \
	-e MARIMOHUB_AUTH_BACKEND=dev \
	-e MARIMOHUB_SANDBOX_EXPOSURE=proxy \
	-e MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true \
	-e MARIMOHUB_AUTH_SESSION_SECRET="${MARIMOHUB_AUTH_SESSION_SECRET:-armada-dev-only-proxy-secret}" \
	-e MARIMOHUB_COMPUTE_IMAGE=marimo-sandbox:local \
	-e ARMADA_URL="${ARMADA_URL:-http://host.docker.internal:30001}" \
	-e ARMADA_QUEUE="$QUEUE" \
	-e ARMADA_NAMESPACE="${ARMADA_NAMESPACE:-default}" \
	-e ARMADA_KUBECONFIG_PATTERN=/etc/marimohub/kubeconfig \
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
