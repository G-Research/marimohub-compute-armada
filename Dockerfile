# marimohub with the Armada compute adapter baked in.
# Build context needs dist/index.js — run `bun run build` first (CI does).
FROM ghcr.io/marimo-team/marimohub:0.4.2

COPY dist/index.js /etc/marimohub/compute.mjs

ENV MARIMOHUB_COMPUTE_BACKEND=library \
	MARIMOHUB_COMPUTE_LIBRARY=/etc/marimohub/compute.mjs
