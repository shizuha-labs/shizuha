package proxy

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

// A malformed upstream entry makes http.NewRequestWithContext fail; the prior
// code ignored that error and dialed a nil request, nil-deref panicking the
// /upstreams/health handler. CheckOnce must instead mark the upstream unhealthy
// without panicking.
func TestCheckOnceMalformedUpstreamDoesNotPanic(t *testing.T) {
	var audit bytes.Buffer
	bad := "http://\x7f-invalid-control-char"
	mgr := NewUpstreamManager([]string{bad}, 1, time.Millisecond, NewAuditEmitter(&audit))

	state := mgr.CheckOnce(context.Background(), bad)

	if state.Healthy {
		t.Fatalf("malformed upstream reported healthy: %+v", state)
	}
	if state.LastError == "" {
		t.Fatalf("expected LastError to be recorded for malformed upstream, got empty: %+v", state)
	}
	if !strings.Contains(audit.String(), `"event":"transport-failed"`) {
		t.Fatalf("expected transport-failed audit event, got: %s", audit.String())
	}
}
