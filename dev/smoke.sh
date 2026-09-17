#!/usr/bin/env bash
# Run dev/smoke.ts from inside the kind docker network.
#
# The agent is reached at the NodePort address Armada reports, 172.18.x.x on
# the docker network, which macOS cannot route to. marimohub runs on that
# network (dev/run-local.sh), so the smoke runs there too: in a bun container
# with this checkout mounted, talking to Armada at the control-plane node's own
# name, which Docker resolves on the kind network (the host's mapped port is not
# reachable from there on a Linux host with a firewall). On a Linux host with the
# kind network routable, `bun run dev/smoke.ts` works directly.
#
# Under ARMADA_EXPOSE=ingress the agent is reached at the hostname Armada
# reports, over the certificate dev/ingress-local.sh issued, so the run trusts
# that script's CA when it exists.
set -euo pipefail
cd "$(dirname "$0")/.."

CA=""
[ -f dev/tls/ca.crt ] && CA=/work/dev/tls/ca.crt

docker run --rm --network kind \
	-v "$PWD":/work -w /work \
	-e ARMADA_URL="${ARMADA_URL:-http://armada-control-plane:30001}" \
	${ARMADA_QUEUE:+-e ARMADA_QUEUE="$ARMADA_QUEUE"} \
	${ARMADA_NAMESPACE:+-e ARMADA_NAMESPACE="$ARMADA_NAMESPACE"} \
	${ARMADA_AGENT_IMAGE:+-e ARMADA_AGENT_IMAGE="$ARMADA_AGENT_IMAGE"} \
	${MARIMOHUB_COMPUTE_IMAGE:+-e MARIMOHUB_COMPUTE_IMAGE="$MARIMOHUB_COMPUTE_IMAGE"} \
	${ARMADA_EXPOSE:+-e ARMADA_EXPOSE="$ARMADA_EXPOSE"} \
	${ARMADA_INGRESS_TLS:+-e ARMADA_INGRESS_TLS="$ARMADA_INGRESS_TLS"} \
	${ARMADA_INGRESS_CERT_NAME:+-e ARMADA_INGRESS_CERT_NAME="$ARMADA_INGRESS_CERT_NAME"} \
	${ARMADA_INGRESS_ANNOTATIONS:+-e ARMADA_INGRESS_ANNOTATIONS="$ARMADA_INGRESS_ANNOTATIONS"} \
	${ARMADA_LOOKOUT_URL:+-e ARMADA_LOOKOUT_URL="$ARMADA_LOOKOUT_URL"} \
	${ARMADA_QUEUE_BY_USER:+-e ARMADA_QUEUE_BY_USER="$ARMADA_QUEUE_BY_USER"} \
	${ARMADA_QUEUE_BY_PROJECT:+-e ARMADA_QUEUE_BY_PROJECT="$ARMADA_QUEUE_BY_PROJECT"} \
	${SMOKE_OWNER_PROJECT:+-e SMOKE_OWNER_PROJECT="$SMOKE_OWNER_PROJECT"} \
	${SMOKE_OWNER_USER:+-e SMOKE_OWNER_USER="$SMOKE_OWNER_USER"} \
	${MARIMOHUB_SURFACES:+-e MARIMOHUB_SURFACES="$MARIMOHUB_SURFACES"} \
	${CA:+-e NODE_EXTRA_CA_CERTS="$CA"} \
	oven/bun:1 bun run dev/smoke.ts "$@"
