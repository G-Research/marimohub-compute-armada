# The kernel agent image: one static binary and nothing else.
#
# It is an init container's image. The init container runs
# `/agent install <path>` to copy the binary into a volume that the kernel
# container mounts, so the kernel image itself never changes.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /agent .

FROM scratch
COPY --from=build /agent /agent
ENTRYPOINT ["/agent"]
