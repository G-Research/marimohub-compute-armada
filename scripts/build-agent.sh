#!/usr/bin/env bash
# Cross-compiles the kernel agent into dist/agent for the npm package: one static
# binary per worker node architecture, the Dockerfile that turns them into the agent
# image, and their checksums. The architectures are the worker nodes', not this
# host's, so every one is built every time.
set -euo pipefail
cd "$(dirname "$0")/.."

out=dist/agent
rm -rf "$out"
for arch in amd64 arm64; do
	CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
		go -C agent build -trimpath -ldflags='-s -w' -o "../$out/linux-$arch/agent" .
done
cp agent/Dockerfile.prebuilt "$out/Dockerfile"
(cd "$out" && sha256sum linux-*/agent >SHA256SUMS)
