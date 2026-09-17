#!/usr/bin/env bash
# Stop everything the dev loop started: the marimohub container and the kind
# cluster with Armada in it. Images, the marimohub data volume, and the binary
# and data directory of dev/run-native.sh are kept, so the next `make kind-all`
# and run script are faster and the notebooks survive; pass --purge to drop
# those too. A native run is a foreground process: Ctrl-C ends it.
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
	rm -rf dev/tls dev/data dev/bin && echo "    removed dev/tls, dev/data and dev/bin"
fi

echo "==> left running"
docker ps --format '    {{.Names}}  {{.Image}}' | grep -E 'armada|marimohub' || echo "    nothing of ours"
