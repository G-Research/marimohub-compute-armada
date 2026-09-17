#!/usr/bin/env bash
# Give the local kind cluster what `ARMADA_EXPOSE=ingress` needs, so a kernel and
# its agent are reached through hostnames rather than NodePorts:
#
#   1. ingress-nginx pinned to the worker node, listening on the node's ports 80
#      and 443 (kind's manifest: hostPort, and it serves Ingresses that name no
#      class, which Armada's never do).
#   2. The executor's hostname suffix set to `<worker-ip-with-dashes>.sslip.io`,
#      so every hostname Armada generates resolves to the worker node without a
#      DNS server of our own. sslip.io answers `*.172-18-0-2.sslip.io` with
#      172.18.0.2.
#   3. A self-signed wildcard certificate for `*.<namespace>.<suffix>` in the
#      secret Armada names by default (`<namespace>-` plus the executor's
#      `certNameSuffix`, `ingress-tls-certificate`). Its CA goes to dev/tls/ for
#      marimohub and the smoke run to trust (NODE_EXTRA_CA_CERTS).
#
# Idempotent: run it again after `make kind-all` recreates the cluster.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE=${NODE:-armada-worker}
NAMESPACE=${ARMADA_NAMESPACE:-default}
INGRESS_NGINX_VERSION=${INGRESS_NGINX_VERSION:-controller-v1.15.1}
TLS_DIR=dev/tls

node_ip=$(kubectl get node "$NODE" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
suffix="${node_ip//./-}.sslip.io"
echo "==> worker $NODE is $node_ip; hostnames will end in .$NAMESPACE.$suffix"

echo "==> installing ingress-nginx $INGRESS_NGINX_VERSION on $NODE"
kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/$INGRESS_NGINX_VERSION/deploy/static/provider/kind/deploy.yaml" >/dev/null
# The hostnames below resolve to this one node, so the controller must stay on it.
kubectl -n ingress-nginx patch deployment ingress-nginx-controller --type merge -p \
	"{\"spec\":{\"template\":{\"spec\":{\"nodeSelector\":{\"kubernetes.io/hostname\":\"$NODE\"}}}}}" >/dev/null
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=180s >/dev/null
kubectl -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=180s >/dev/null

echo "==> pointing the executor's ingress hostname suffix at $suffix"
kubectl -n armada patch executor armada-executor --type merge -p \
	"{\"spec\":{\"applicationConfig\":{\"kubernetes\":{\"podDefaults\":{\"ingress\":{\"hostnameSuffix\":\"$suffix\"}}}}}}" >/dev/null
# The operator rewrites the executor's config secret and rolls the deployment
# on its checksum; wait for the executor that read the new suffix.
for _ in $(seq 1 30); do
	if kubectl -n armada get secret armada-executor -o jsonpath='{.data.armada-executor-config\.yaml}' 2>/dev/null | base64 -d | grep -q "$suffix"; then
		break
	fi
	sleep 2
done
kubectl -n armada rollout status deployment/armada-executor --timeout=180s >/dev/null

echo "==> issuing a wildcard certificate for *.$NAMESPACE.$suffix"
mkdir -p "$TLS_DIR"
if [ ! -f "$TLS_DIR/ca.crt" ]; then
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
		-subj "/CN=marimohub-armada local ingress CA" \
		-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
		-keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" 2>/dev/null
fi
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
	-subj "/CN=*.$NAMESPACE.$suffix" -keyout "$TLS_DIR/tls.key" -out "$TLS_DIR/tls.csr" 2>/dev/null
printf 'subjectAltName=DNS:*.%s.%s\nextendedKeyUsage=serverAuth\n' "$NAMESPACE" "$suffix" >"$TLS_DIR/tls.ext"
openssl x509 -req -in "$TLS_DIR/tls.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" -CAcreateserial \
	-days 3650 -extfile "$TLS_DIR/tls.ext" -out "$TLS_DIR/tls.crt" 2>/dev/null
kubectl -n "$NAMESPACE" create secret tls "$NAMESPACE-ingress-tls-certificate" \
	--cert="$TLS_DIR/tls.crt" --key="$TLS_DIR/tls.key" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

cat <<MSG
==> ready. Kernels are reached at https://kernel-<port>-armada-<job>-0.$NAMESPACE.$suffix
    export ARMADA_EXPOSE=ingress
    bun run smoke            # trusts $TLS_DIR/ca.crt automatically
    dev/run-local.sh         # so does marimohub
MSG
