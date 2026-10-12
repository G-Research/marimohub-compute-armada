# The kernel agent image: one static binary and nothing else.
#
# It is an init container's image. The init container runs
# `/agent install <path>` to copy the binary into a volume that the kernel
# container mounts, so the kernel image itself never changes.
#
# The build context is agent/, which has no CHANGELOG.md, so `agent --version`
# reports VERSION: "dev" unless the build passes one, for example
# `--build-arg VERSION="$(bun run scripts/changelog.ts version)"`.
FROM golang:1.26-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /agent .

FROM scratch
COPY --from=build /agent /agent
ENTRYPOINT ["/agent"]
