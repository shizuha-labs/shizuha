IMAGE ?= mcp-auth-proxy
TAG ?= dev
BIN ?= bin/mcp-auth-proxy
GO_IMAGE ?= golang:1.22-alpine
RUN_GO = docker run --rm -v "$(CURDIR)":/src -w /src $(GO_IMAGE)

HAVE_GO := $(shell command -v go 2>/dev/null)

.PHONY: build test fmt image clean

ifeq ($(HAVE_GO),)
build:
	mkdir -p bin
	$(RUN_GO) sh -c "CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o $(BIN) ./cmd/mcp-auth-proxy"

test:
	$(RUN_GO) go test ./...

fmt:
	$(RUN_GO) gofmt -w cmd/mcp-auth-proxy/main.go internal/proxy/*.go
else
build:
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o $(BIN) ./cmd/mcp-auth-proxy

test:
	go test ./...

fmt:
	gofmt -w cmd/mcp-auth-proxy/main.go internal/proxy/*.go
endif

image:
	docker build -t $(IMAGE):$(TAG) .

clean:
	rm -rf bin
