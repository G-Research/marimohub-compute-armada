#!/usr/bin/env bash
# Steps shared by dev/run-local.sh and dev/run-native.sh. Sourced, not run.
# Expects the caller to have `cd`ed to the repository root and to have set
# ARMADACTL, QUEUE, AGENT_IMAGE and NODE.

# The kernel image the dev scripts start sessions with, unless
# MARIMOHUB_COMPUTE_IMAGE says otherwise. marimohub publishes this image from its
# main branch with no per-release tag (`latest` and the marimo-version tag are
# overwritten), so it is pinned by digest to the build that matches the
# marimohub release in the Dockerfile. 0.6.4: marimo 0.25.2 and the 0.6.4
# notebook bridge, built 2026-11-13 from marimohub main at 2882f3144.
# Bump it together with the Dockerfile.
SANDBOX_IMAGE=ghcr.io/marimo-team/marimo-sandbox:py3.13-marimo0.25.2@sha256:921257440ad858083b81da385a9613710fdb0bb986aedc2e20ec4e799c08b623

# Build the kernel agent image for the worker node's architecture and import it
# into the node's containerd. The agent runs on the node, so it is built for the
# node and not for marimohub, which is amd64 under emulation on Apple Silicon.
build_agent_image() {
	echo "==> building the kernel agent image"
	case "$(docker exec "$NODE" uname -m)" in
	aarch64) PLATFORM=linux/arm64 ;;
	x86_64) PLATFORM=linux/amd64 ;;
	*) echo "unknown node architecture"; exit 1 ;;
	esac
	docker build --platform "$PLATFORM" -t "$AGENT_IMAGE" agent

	# `kind load docker-image` fails on multi-platform manifests from Docker
	# Desktop's containerd image store ("content digest ... not found"), so the
	# archive goes straight into the node's containerd, for the one platform.
	echo "==> loading it into the kind node"
	docker save "$AGENT_IMAGE" | docker exec -i "$NODE" ctr -n k8s.io images import --platform "$PLATFORM" - >/dev/null
}

ensure_queue() {
	echo "==> ensuring Armada queue '$QUEUE' exists"
	local queue_out
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
}
