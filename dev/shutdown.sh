#!/usr/bin/env bash
# Stop everything the dev loop started: the marimohub container and the kind
# cluster with Armada in it. Images and the marimohub data volume are kept, so
# the next `make kind-all` and `dev/run-local.sh` are faster and the notebooks
# survive; pass --purge to drop those too.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=${CONTAINER:-marimohub-armada}
CLUSTER=${KIND_CLUSTER_NAME:-armada}
OPERATOR=${ARMADA_OPERATOR:-$HOME/Projects/armada-operator}
# armada-operator's Makefile installs kind under its own bin/; fall back to PATH.
KIND=${KIND:-$OPERATOR/bin/tooling/kind}
command -v "$KIND" >/dev/null 2>&1 || KIND=kind

PURGE=false
[ "${1:-}" = "--purge" ] && PURGE=true

echo "==> removing the marimohub container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "    removed $CONTAINER" || echo "    not running"

echo "==> deleting the kind cluster '$CLUSTER'"
if "$KIND" get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
	"$KIND" delete cluster --name "$CLUSTER"
else
	echo "    no such cluster"
fi

if $PURGE; then
	echo "==> purging"
	docker volume rm marimohub-armada-data >/dev/null 2>&1 && echo "    removed volume marimohub-armada-data" || true
	docker rmi marimohub-armada:dev marimohub-kernel-agent:local marimo-sandbox:local >/dev/null 2>&1 && echo "    removed dev images" || true
	rm -rf dev/tls && echo "    removed dev/tls"
fi

echo "==> left running"
docker ps --format '    {{.Names}}  {{.Image}}' | grep -E 'armada|marimohub' || echo "    nothing of ours"
