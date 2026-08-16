package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// credServer builds a Server with the credential endpoint configured for tests.
// (uidPtr is shared from broker_review_test.go.)
func credServer(audit *bytes.Buffer, expectedUID *uint32) *Server {
	return NewServer(
		Config{TokenAudience: "aud", ExpectedAgentUID: expectedUID, ReconnectMaxAttempts: 1, ReconnectBaseBackoff: time.Millisecond},
		NewAuditEmitter(audit),
		StubTokenReviewer{Allow: true},
		StubMintClient{Allow: true},
	)
}

// credRequest builds a POST /credential/request, optionally injecting a peer UID
// via the same unexported context key ConnContext uses on real UDS connections.
func credRequest(body string, peerUID *uint32) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "http://unix/credential/request", strings.NewReader(body))
	if peerUID != nil {
		r = r.WithContext(context.WithValue(r.Context(), peerCredContextKey{}, PeerCred{UID: *peerUID}))
	}
	return r
}

// stubBroker is a test CredentialBroker that grants or denies deterministically.
type stubBroker struct {
	grant  CredentialGrant
	err    error
	gotUID uint32
	gotReq CredentialRequest
	called bool
}

func (b *stubBroker) RequestGrant(_ context.Context, uid uint32, req CredentialRequest) (CredentialGrant, error) {
	b.called = true
	b.gotUID = uid
	b.gotReq = req
	return b.grant, b.err
}

func TestCredentialRequest_PeerCredUnavailable_401(t *testing.T) {
	var audit bytes.Buffer
	srv := credServer(&audit, uidPtr(1000))
	w := httptest.NewRecorder()
	srv.handleCredentialRequest(w, credRequest(`{"service":"github"}`, nil)) // no peer cred
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
	if !strings.Contains(audit.String(), `"failure_class":"tier1_peercred_fail"`) {
		t.Fatalf("missing peercred-fail audit: %s", audit.String())
	}
}

func TestCredentialRequest_ExpectedUIDUnconfigured_503(t *testing.T) {
	var audit bytes.Buffer
	srv := credServer(&audit, nil) // ExpectedAgentUID nil → cannot identify caller
	w := httptest.NewRecorder()
	srv.handleCredentialRequest(w, credRequest(`{"service":"github"}`, uidPtr(1000)))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d", w.Code)
	}
	if !strings.Contains(audit.String(), `"failure_class":"expected_uid_unconfigured"`) {
		t.Fatalf("missing unconfigured audit: %s", audit.String())
	}
}

func TestCredentialRequest_UIDMismatch_401(t *testing.T) {
	var audit bytes.Buffer
	srv := credServer(&audit, uidPtr(1000))
	w := httptest.NewRecorder()
	srv.handleCredentialRequest(w, credRequest(`{"service":"github"}`, uidPtr(1234))) // wrong uid
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
	if !strings.Contains(audit.String(), `"expected_uid":1000`) {
		t.Fatalf("missing uid-mismatch audit: %s", audit.String())
	}
}

func TestCredentialRequest_UnsupportedService_400(t *testing.T) {
	var audit bytes.Buffer
	srv := credServer(&audit, uidPtr(1000))
	w := httptest.NewRecorder()
	srv.handleCredentialRequest(w, credRequest(`{"service":"bitcoin-wallet"}`, uidPtr(1000)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
	if !strings.Contains(audit.String(), `"failure_class":"unsupported_service"`) {
		t.Fatalf("missing unsupported-service audit: %s", audit.String())
	}
}

func TestCredentialRequest_DefaultBrokerFailsClosed_503(t *testing.T) {
	var audit bytes.Buffer
	srv := credServer(&audit, uidPtr(1000)) // no SetCredentialBroker → denyAllBroker
	w := httptest.NewRecorder()
	srv.handleCredentialRequest(w, credRequest(`{"service":"github"}`, uidPtr(1000)))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 (fail-closed), got %d", w.Code)
	}
	if !strings.Contains(audit.String(), `"failure_class":"broker_unconfigured"`) {
		t.Fatalf("missing broker_unconfigured audit: %s", audit.String())
	}
}

func TestCredentialRequest_BrokerDenied_403(t *testing.T) {
	var audit bytes.Buffer
	srv := credServer(&audit, uidPtr(1000))
	srv.SetCredentialBroker(&stubBroker{err: errors.New("policy: repo not allowed")})
	w := httptest.NewRecorder()
	srv.handleCredentialRequest(w, credRequest(`{"service":"github","scope":"shizuha-labs/secret"}`, uidPtr(1000)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", w.Code)
	}
	if strings.Contains(audit.String(), "secret") && strings.Contains(audit.String(), "repo not allowed") {
		t.Fatalf("audit leaked broker error detail: %s", audit.String())
	}
}

func TestCredentialRequest_Granted_200_NoSecretInAudit(t *testing.T) {
	var audit bytes.Buffer
	srv := credServer(&audit, uidPtr(1000))
	broker := &stubBroker{grant: CredentialGrant{
		Service:   "github",
		Scope:     "shizuha-labs/shizuha-beta",
		Data:      map[string]string{"token": "ghs_SUPERSECRET"},
		ExpiresAt: time.Now().Add(time.Hour),
		RequestID: "req-1",
	}}
	srv.SetCredentialBroker(broker)
	w := httptest.NewRecorder()
	srv.handleCredentialRequest(w, credRequest(`{"service":"github","scope":"shizuha-labs/shizuha-beta","ttl_seconds":3600}`, uidPtr(1000)))
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	// Broker received the authenticated UID + parsed request.
	if !broker.called || broker.gotUID != 1000 || broker.gotReq.Service != "github" {
		t.Fatalf("broker not called correctly: called=%v uid=%d req=%+v", broker.called, broker.gotUID, broker.gotReq)
	}
	// Response carries the secret to the agent...
	var got CredentialGrant
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad response json: %v", err)
	}
	if got.Data["token"] != "ghs_SUPERSECRET" {
		t.Fatalf("grant secret not returned to agent")
	}
	// ...but the secret MUST NOT appear in the audit log.
	if strings.Contains(audit.String(), "ghs_SUPERSECRET") {
		t.Fatalf("SECRET LEAKED INTO AUDIT: %s", audit.String())
	}
	if !strings.Contains(audit.String(), `"credential-granted"`) || !strings.Contains(audit.String(), `"has_data":true`) {
		t.Fatalf("missing metadata-only grant audit: %s", audit.String())
	}
}

func TestCredentialRequest_MethodNotAllowed_405(t *testing.T) {
	var audit bytes.Buffer
	srv := credServer(&audit, uidPtr(1000))
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "http://unix/credential/request", nil)
	r = r.WithContext(context.WithValue(r.Context(), peerCredContextKey{}, PeerCred{UID: 1000}))
	srv.handleCredentialRequest(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", w.Code)
	}
}
