#!/usr/bin/env bash
# Rebuild the adapter, bake it into the marimohub image, and run it against the
# Armada in the local kind cluster. Assumes Armada is already up (see README.md).
set -euo pipefail

cd "$(dirname "$0")/.."

ARMADACTL=${ARMADACTL:-$HOME/Projects/armada-operator/bin/app/armadactl}
QUEUE=${ARMADA_QUEUE:-marimohub}
IMAGE=${IMAGE:-marimohub-armada:dev}
CONTAINER=${CONTAINER:-marimohub-armada}
PORT=${PORT:-3000}

echo "==> building adapter bundle"
bun run build

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
docker run -d --name "$CONTAINER" --platform linux/amd64 \
	-p "$PORT:3000" \
	-v marimohub-armada-data:/data \
	-e MARIMOHUB_STORAGE_BACKEND=fs \
	-e MARIMOHUB_STORAGE_FS_ROOT=/data \
	-e MARIMOHUB_AUTH_BACKEND=dev \
	-e MARIMOHUB_COMPUTE_IMAGE=marimo-sandbox:local \
	-e ARMADA_URL="${ARMADA_URL:-http://host.docker.internal:30001}" \
	-e ARMADA_QUEUE="$QUEUE" \
	-e ARMADA_NAMESPACE="${ARMADA_NAMESPACE:-default}" \
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
