#!/usr/bin/env bash
# Steps shared by dev/run-local.sh and dev/run-native.sh. Sourced, not run.
# Expects the caller to have `cd`ed to the repository root and to have set
# ARMADACTL, QUEUE, AGENT_IMAGE and NODE.

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
