package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func unixHTTPClient(sock string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
}

func TestHealthServedOverUnixSocket(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "proxy.sock")
	var audit bytes.Buffer
	srv := NewServer(Config{SocketPath: sock, TokenAudience: "aud", ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond}, NewAuditEmitter(&audit), StubTokenReviewer{Allow: true}, StubMintClient{Allow: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	waitForSock(t, sock)
	resp, err := unixHTTPClient(sock).Get("http://unix/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if !strings.Contains(audit.String(), `"tcp_listener":false`) {
		t.Fatalf("startup audit did not record tcp_listener=false: %s", audit.String())
	}
}

func TestSocketReachableByAgentUID(t *testing.T) {
	// P1 (PLAT-80/#32): the agent container runs as a different UID and must be
	// able to traverse the socket dir and connect to the socket. Security is
	// enforced by SO_PEERCRED in handleBootstrap, not by these mode bits — but a
	// sidecar-private 0o750 dir / 0o660 socket fails every /bootstrap before
	// SO_PEERCRED ever runs. Guard the connect-open mode against regression.
	sock := filepath.Join(t.TempDir(), "proxy.sock")
	var audit bytes.Buffer
	srv := NewServer(Config{SocketPath: sock, TokenAudience: "aud", ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond}, NewAuditEmitter(&audit), StubTokenReviewer{Allow: true}, StubMintClient{Allow: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	waitForSock(t, sock)
	si, err := os.Stat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if si.Mode().Perm()&0o006 != 0o006 {
		t.Fatalf("socket mode %o does not permit other-UID connect (need o+rw)", si.Mode().Perm())
	}
	di, err := os.Stat(filepath.Dir(sock))
	if err != nil {
		t.Fatal(err)
	}
	if di.Mode().Perm()&0o001 == 0 {
		t.Fatalf("socket dir mode %o does not permit other-UID traverse (need o+x)", di.Mode().Perm())
	}
}

func TestPreExistingLeafSocketDirDoesNotBlockStartup(t *testing.T) {
	// PLAT-149/PLAT-169 fleet topology: the socket dir is a PRE-EXISTING
	// pod-shared volume mount (emptyDir) the sidecar does NOT own — under a pod
	// fsGroup it is root:fsGroup while the sidecar runs distroless nonroot, so a
	// chmod of the leaf EPERMs (you can't chmod a dir you don't own). Serve must
	// treat the pre-existing leaf as best-effort and still start, since fsGroup
	// already grants the agent's GID access; hard-failing there would crash the
	// broker and /readyz would never go green. We can't reproduce cross-UID
	// ownership in a non-root test, but we guard the pre-existing-leaf path:
	// Serve starts and the socket is reachable when the leaf already exists.
	base, err := os.MkdirTemp("", "p149")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	leaf := filepath.Join(base, "mcp-auth-proxy")
	if err := os.MkdirAll(leaf, 0o775); err != nil { // emptyDir-like, pre-exists
		t.Fatal(err)
	}
	sock := filepath.Join(leaf, "proxy.sock")
	var audit bytes.Buffer
	srv := NewServer(Config{SocketPath: sock, TokenAudience: "aud", ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond}, NewAuditEmitter(&audit), StubTokenReviewer{Allow: true}, StubMintClient{Allow: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	waitForSock(t, sock)
	resp, err := unixHTTPClient(sock).Get("http://unix/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	// The socket itself is created+owned by the broker, so it must still be
	// connect-open (0o666) regardless of who owns the pre-existing leaf dir.
	si, err := os.Stat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if si.Mode().Perm()&0o006 != 0o006 {
		t.Fatalf("socket mode %o does not permit other-UID connect (need o+rw)", si.Mode().Perm())
	}
}

func TestSocketDirHierarchyTraversableUnderRestrictiveUmask(t *testing.T) {
	// P2 (PLAT-80/#32): every INTERMEDIATE directory the sidecar creates for the
	// UDS path must be traversable by the agent UID, not just the leaf. MkdirAll
	// honors the umask, so under a restrictive umask an intermediate parent would
	// otherwise be 0o700 and block traversal before SO_PEERCRED runs.
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	// Short base so the full nested UDS path stays under the 108-byte sun_path
	// limit (t.TempDir embeds the long test name and would overflow it).
	base, err := os.MkdirTemp("", "p80")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	// Two new intermediate components must both be created by Serve and chmod'd
	// traversable (proves the fix covers intermediates, not just the leaf).
	created := []string{
		filepath.Join(base, "a"),
		filepath.Join(base, "a", "b"),
	}
	sock := filepath.Join(created[1], "p.sock")
	var audit bytes.Buffer
	srv := NewServer(Config{SocketPath: sock, TokenAudience: "aud", ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond}, NewAuditEmitter(&audit), StubTokenReviewer{Allow: true}, StubMintClient{Allow: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	waitForSock(t, sock)
	for _, d := range created {
		fi, err := os.Stat(d)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm()&0o001 == 0 {
			t.Fatalf("created dir %s mode %o is not other-UID traversable (need o+x)", d, fi.Mode().Perm())
		}
	}
}

func TestExistingRestrictiveSocketDirIsMadeTraversable(t *testing.T) {
	// P2 (post-merge recheck): the pod-shared leaf socket directory can already
	// exist before the sidecar starts (for example as the mounted shared volume)
	// with restrictive permissions. The sidecar must preserve the safe leaf-dir
	// chmod so a pre-existing 0o700/0o750 leaf does not block the agent UID before
	// SO_PEERCRED.
	base, err := os.MkdirTemp("", "p80")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	sockDir := filepath.Join(base, "socketdir")
	if err := os.Mkdir(sockDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sockDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(sockDir, "p.sock")
	var audit bytes.Buffer
	srv := NewServer(Config{SocketPath: sock, TokenAudience: "aud", ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond}, NewAuditEmitter(&audit), StubTokenReviewer{Allow: true}, StubMintClient{Allow: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	waitForSock(t, sock)
	fi, err := os.Stat(sockDir)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o001 == 0 {
		t.Fatalf("existing socket dir mode %o is not other-UID traversable (need o+x)", fi.Mode().Perm())
	}
}

func TestBootstrapSucceedsWithExplicitStubs(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "proxy.sock")
	var audit bytes.Buffer
	srv := NewServer(Config{SocketPath: sock, TokenAudience: "aud", ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond}, NewAuditEmitter(&audit), StubTokenReviewer{Allow: true}, StubMintClient{Allow: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	waitForSock(t, sock)
	body, _ := json.Marshal(map[string]string{"sa_token": "projected-token", "claimed_agent_id": "agent-1"})
	resp, err := unixHTTPClient(sock).Post("http://unix/bootstrap", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if !strings.Contains(audit.String(), `"event":"bootstrap-succeeded"`) {
		t.Fatalf("missing success audit: %s", audit.String())
	}
}

func TestBootstrapFailsClosedOnTokenReview(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "proxy.sock")
	var audit bytes.Buffer
	srv := NewServer(Config{SocketPath: sock, TokenAudience: "aud", ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond}, NewAuditEmitter(&audit), FailClosedTokenReviewer{Reason: "no tokenreview"}, StubMintClient{Allow: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	waitForSock(t, sock)
	resp, err := unixHTTPClient(sock).Post("http://unix/bootstrap", "application/json", strings.NewReader(`{"sa_token":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if !strings.Contains(audit.String(), `"failure_class":"tier2_tokenreview_fail"`) {
		t.Fatalf("missing identity failure audit: %s", audit.String())
	}
}

func TestSourceDoesNotOpenTCPListener(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	_ = entries
	paths := []string{"server.go"}
	for _, path := range paths {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), `Listen("tcp`) || strings.Contains(string(b), `Listen("tcp4`) || strings.Contains(string(b), `Listen("tcp6`) {
			t.Fatalf("%s opens a TCP listener", path)
		}
	}
}

func waitForSock(t *testing.T, sock string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(sock); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("socket %s not created", sock)
}
