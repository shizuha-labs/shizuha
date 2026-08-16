package proxy

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newProbeServer starts a proxy serving over a fresh temp UDS and returns the
// socket path. It reuses the same stubs and helpers as server_test.go.
func newProbeServer(t *testing.T) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "proxy.sock")
	var audit bytes.Buffer
	srv := NewServer(
		Config{SocketPath: sock, TokenAudience: "aud", ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond},
		NewAuditEmitter(&audit),
		StubTokenReviewer{Allow: true},
		StubMintClient{Allow: true},
	)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = srv.Serve(ctx) }()
	waitForSock(t, sock)
	return sock
}

func TestHealthCheckLivenessOK(t *testing.T) {
	sock := newProbeServer(t)
	// /healthz is always 200 once the socket is up.
	if err := HealthCheck(context.Background(), HealthCheckOptions{SocketPath: sock}); err != nil {
		t.Fatalf("liveness probe failed on a live proxy: %v", err)
	}
}

func TestHealthCheckReadinessGatedOnBootstrap(t *testing.T) {
	sock := newProbeServer(t)

	// Before bootstrap, /readyz is 503 -> readiness probe must fail.
	if err := HealthCheck(context.Background(), HealthCheckOptions{SocketPath: sock, Ready: true}); err == nil {
		t.Fatal("readiness probe passed before bootstrap; want failure (503)")
	}

	// Liveness should still pass even when not ready.
	if err := HealthCheck(context.Background(), HealthCheckOptions{SocketPath: sock}); err != nil {
		t.Fatalf("liveness probe failed pre-bootstrap: %v", err)
	}

	// Bootstrap the session so /readyz flips to 200.
	resp, err := unixHTTPClient(sock).Post("http://unix/bootstrap", "application/json",
		strings.NewReader(`{"sa_token":"projected-token","claimed_agent_id":"agent-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status=%d", resp.StatusCode)
	}

	// After bootstrap, readiness probe must pass.
	if err := HealthCheck(context.Background(), HealthCheckOptions{SocketPath: sock, Ready: true}); err != nil {
		t.Fatalf("readiness probe failed after bootstrap: %v", err)
	}
}

func TestHealthCheckDialFailureOnBadSocket(t *testing.T) {
	// A non-existent socket path must yield a non-nil error (dial failure), not
	// a false-healthy pass.
	bad := filepath.Join(t.TempDir(), "does-not-exist.sock")
	if err := HealthCheck(context.Background(), HealthCheckOptions{SocketPath: bad}); err == nil {
		t.Fatal("probe passed against a non-existent socket; want dial failure")
	}
}

func TestHealthCheckEmptySocketIsUsageError(t *testing.T) {
	if err := HealthCheck(context.Background(), HealthCheckOptions{SocketPath: ""}); err == nil {
		t.Fatal("empty --socket accepted; want error")
	}
}

func TestRunHealthCheckCommandExitCodes(t *testing.T) {
	sock := newProbeServer(t)
	var stderr bytes.Buffer

	// Live proxy, liveness -> 0.
	if code := RunHealthCheckCommand([]string{"--socket", sock}, &stderr); code != 0 {
		t.Fatalf("liveness exit=%d want 0 (stderr=%q)", code, stderr.String())
	}

	// Live proxy, readiness before bootstrap -> 1.
	stderr.Reset()
	if code := RunHealthCheckCommand([]string{"--ready", "--socket", sock}, &stderr); code != 1 {
		t.Fatalf("pre-bootstrap readiness exit=%d want 1", code)
	}

	// Bad socket -> 1.
	stderr.Reset()
	bad := filepath.Join(t.TempDir(), "nope.sock")
	if code := RunHealthCheckCommand([]string{"--socket", bad}, &stderr); code != 1 {
		t.Fatalf("bad-socket exit=%d want 1", code)
	}

	// Unparseable flag -> 2 (usage error).
	stderr.Reset()
	if code := RunHealthCheckCommand([]string{"--bogus"}, &stderr); code != 2 {
		t.Fatalf("bad-flag exit=%d want 2", code)
	}

	// Help is also the architecture smoke-test command used by image CI: it
	// proves the native binary exists and executes without needing a live UDS.
	stderr.Reset()
	if code := RunHealthCheckCommand([]string{"--help"}, &stderr); code != 0 {
		t.Fatalf("help exit=%d want 0", code)
	}
}

// TestHealthCheckSourceDoesNotOpenTCPListener mirrors
// TestSourceDoesNotOpenTCPListener for the healthcheck path: the probe must
// dial the UDS only and never open a TCP listener (ADR-PLAT-002 §4-INV-2).
func TestHealthCheckSourceDoesNotOpenTCPListener(t *testing.T) {
	b, err := os.ReadFile("healthcheck.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`Listen("tcp`, `Listen("tcp4`, `Listen("tcp6`, "ListenAndServe"} {
		if strings.Contains(string(b), bad) {
			t.Fatalf("healthcheck.go contains forbidden %q", bad)
		}
	}
}
