package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const testProjectionNonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func projectionRequest(uid uint32, nonce string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/mcp-projection", strings.NewReader(`{"nonce":"`+nonce+`"}`))
	return req.WithContext(context.WithValue(req.Context(), peerCredContextKey{}, PeerCred{UID: uid, GID: uid, PID: 1}))
}

func TestMCPProjectionRelaysFreshNonceWithoutCaching(t *testing.T) {
	var calls atomic.Int32
	producer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if got := r.Header.Get("Authorization"); got != "Bearer coordinator" {
			t.Fatalf("authorization = %q", got)
		}
		var body mcpProjectionRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Nonce != testProjectionNonce {
			t.Fatalf("nonce = %q", body.Nonce)
		}
		_, _ = w.Write([]byte(`{"nonce":"` + body.Nonce + `","projection":{},"signature":"opaque"}`))
	}))
	defer producer.Close()

	s := newTokenServer(Config{
		ExpectedAgentUID:       uidPtr(1000),
		ProjectionURL:          producer.URL + "/agents/{agent_id}/projection",
		AgentID:                "agent-1",
		CoordinatorBearerToken: "coordinator",
	})
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		s.handleMCPProjection(w, projectionRequest(1000, testProjectionNonce))
		if w.Code != http.StatusOK {
			t.Fatalf("request %d: status=%d body=%s", i, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), testProjectionNonce) {
			t.Fatalf("request %d omitted relayed nonce: %s", i, w.Body.String())
		}
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("producer calls=%d; want 2 (no cache)", got)
	}
}

func TestMCPProjectionFailsClosedBeforeProducerForWrongPeer(t *testing.T) {
	var calls atomic.Int32
	producer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer producer.Close()
	s := newTokenServer(Config{
		ExpectedAgentUID: uidPtr(1000), ProjectionURL: producer.URL,
		AgentID: "agent-1", CoordinatorBearerToken: "coordinator",
	})
	w := httptest.NewRecorder()
	s.handleMCPProjection(w, projectionRequest(1001, testProjectionNonce))
	if w.Code != http.StatusUnauthorized || calls.Load() != 0 {
		t.Fatalf("status=%d producer_calls=%d", w.Code, calls.Load())
	}
}

func TestMCPProjectionRefusesInvalidNonceAndProducerFailures(t *testing.T) {
	producer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no projection", http.StatusServiceUnavailable)
	}))
	defer producer.Close()
	s := newTokenServer(Config{
		ExpectedAgentUID: uidPtr(1000), ProjectionURL: producer.URL,
		AgentID: "agent-1", CoordinatorBearerToken: "coordinator",
	})

	w := httptest.NewRecorder()
	s.handleMCPProjection(w, projectionRequest(1000, "short"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid nonce status=%d", w.Code)
	}
	w = httptest.NewRecorder()
	s.handleMCPProjection(w, projectionRequest(1000, testProjectionNonce))
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "no projection") {
		t.Fatalf("producer refusal status=%d body=%s", w.Code, w.Body.String())
	}
}
