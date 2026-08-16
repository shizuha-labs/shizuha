package proxy

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// DefaultHealthCheckTimeout bounds a single exec-over-UDS probe so a wedged
// proxy cannot hang the kubelet's probe indefinitely.
const DefaultHealthCheckTimeout = 2 * time.Second

// HealthCheckOptions configures an exec-over-UDS health probe.
//
// The probe is a thin client: it dials the pod-local Unix domain socket and
// maps the proxy's own HTTP status to a process exit code. It deliberately does
// NOT re-implement readiness logic — the server owns that (`/readyz` returns 200
// iff bootstrap is complete, 503 otherwise).
type HealthCheckOptions struct {
	// SocketPath is the pod-local proxy UDS to dial.
	SocketPath string
	// Ready selects readiness (`/readyz`) instead of liveness (`/healthz`).
	Ready bool
	// Timeout bounds the probe; <= 0 uses DefaultHealthCheckTimeout.
	Timeout time.Duration
}

// HealthCheck dials the pod-local UDS and probes the proxy's health endpoint.
//
// It returns nil iff the endpoint reports healthy/ready (HTTP 200); any dial
// failure, non-200 response, or timeout yields a non-nil error. It opens NO TCP
// listener and dials ONLY the Unix domain socket, preserving ADR-PLAT-002
// §4-INV-2 (absolute no-TCP). It is the binary's own static healthcheck so the
// distroless sidecar image (no shell, no curl) can run an exec-over-UDS probe.
func HealthCheck(ctx context.Context, opts HealthCheckOptions) error {
	if opts.SocketPath == "" {
		return fmt.Errorf("healthcheck: --socket is required")
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultHealthCheckTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	path := "/healthz"
	if opts.Ready {
		path = "/readyz"
	}

	// The dialer ignores the bogus host:port in the request URL and connects to
	// the UDS — the same pattern the server's tests use to reach it. No TCP
	// socket is ever opened by this path.
	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", opts.SocketPath)
			},
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix"+path, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("healthcheck: dialing %s: %w", opts.SocketPath, err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: GET %s returned HTTP %d", path, resp.StatusCode)
	}
	return nil
}

// RunHealthCheckCommand parses the `healthcheck` subcommand flags and runs the
// probe, returning a process exit code: 0 on healthy/ready, 1 on an unhealthy /
// unreachable proxy, 2 on a usage error.
//
// Usage: mcp-auth-proxy healthcheck --socket <uds-path> [--ready] [--timeout <dur>]
func RunHealthCheckCommand(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	fs.SetOutput(stderr)
	socket := fs.String("socket", getenv("MCP_AUTH_PROXY_SOCKET", "/run/shizuha/mcp-auth-proxy/proxy.sock"),
		"path to the pod-local proxy UDS")
	ready := fs.Bool("ready", false, "probe readiness (/readyz) instead of liveness (/healthz)")
	timeout := fs.Duration("timeout", DefaultHealthCheckTimeout, "probe timeout")
	if err := fs.Parse(args); errors.Is(err, flag.ErrHelp) {
		return 0
	} else if err != nil {
		return 2
	}
	if err := HealthCheck(context.Background(), HealthCheckOptions{
		SocketPath: *socket,
		Ready:      *ready,
		Timeout:    *timeout,
	}); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}
