#!/usr/bin/env bash
# Cross-compiles the kernel agent into dist/agent for the npm package: one static
# binary per worker node architecture, the Dockerfile that turns them into the agent
# image, and their checksums. The architectures are the worker nodes', not this
# host's, so every one is built every time. Each binary reports the newest version in
# CHANGELOG.md as its `--version`, the version the release publishes it under.
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(bun run scripts/changelog.ts version)"

out=dist/agent
rm -rf "$out"
for arch in amd64 arm64; do
	CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
		go -C agent build -trimpath -ldflags="-s -w -X main.version=${version:-dev}" -o "../$out/linux-$arch/agent" .
done
cp agent/Dockerfile.prebuilt "$out/Dockerfile"
(cd "$out" && sha256sum linux-*/agent >SHA256SUMS)
