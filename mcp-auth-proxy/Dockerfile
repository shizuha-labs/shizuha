# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN go test ./... \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/mcp-auth-proxy ./cmd/mcp-auth-proxy

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/mcp-auth-proxy /mcp-auth-proxy
USER nonroot:nonroot
ENTRYPOINT ["/mcp-auth-proxy"]
