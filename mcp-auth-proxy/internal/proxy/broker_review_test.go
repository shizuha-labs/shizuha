package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func uidPtr(u uint32) *uint32 { return &u }

func newTokenServer(cfg Config) *Server {
	return NewServer(cfg, NewAuditEmitter(io.Discard), nil, nil)
}

func tokenReq(uid uint32) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/token", nil)
	return req.WithContext(context.WithValue(req.Context(), peerCredContextKey{}, PeerCred{UID: uid, GID: uid, PID: 1}))
}

// P1: /token must FAIL CLOSED when the expected agent UID is unconfigured.
func TestTokenFailsClosedWithoutExpectedUID(t *testing.T) {
	s := newTokenServer(Config{}) // ExpectedAgentUID nil
	s.SetAgentSession(AgentSession{Access: "jwt"})
	w := httptest.NewRecorder()
	s.handleToken(w, tokenReq(1000))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 fail-closed when ExpectedAgentUID unset, got %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "jwt") {
		t.Fatalf("token leaked while unconfigured: %s", w.Body.String())
	}
}

func TestTokenServedToExpectedUID(t *testing.T) {
	s := newTokenServer(Config{ExpectedAgentUID: uidPtr(1000)})
	s.SetAgentSession(AgentSession{Access: "jwt-abc", Exp: time.Now().Add(time.Hour)})
	w := httptest.NewRecorder()
	s.handleToken(w, tokenReq(1000))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "jwt-abc") {
		t.Fatalf("token not served: %s", w.Body.String())
	}
}

func TestTokenWrongUID(t *testing.T) {
	s := newTokenServer(Config{ExpectedAgentUID: uidPtr(1000)})
	s.SetAgentSession(AgentSession{Access: "jwt"})
	w := httptest.NewRecorder()
	s.handleToken(w, tokenReq(1001))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong uid, got %d", w.Code)
	}
}

// P2: never hand back an expired JWT.
func TestTokenExpiredNotServed(t *testing.T) {
	s := newTokenServer(Config{ExpectedAgentUID: uidPtr(1000)})
	s.SetAgentSession(AgentSession{Access: "jwt", Exp: time.Now().Add(-time.Minute)})
	w := httptest.NewRecorder()
	s.handleToken(w, tokenReq(1000))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for expired token, got %d", w.Code)
	}
}

// P2: /readyz must report not-ready when the held token is expired.
func TestReadyzExpiredNotReady(t *testing.T) {
	s := newTokenServer(Config{ExpectedAgentUID: uidPtr(1000)})
	s.SetAgentSession(AgentSession{Access: "jwt", Exp: time.Now().Add(-time.Minute)})
	w := httptest.NewRecorder()
	s.handleReadyz(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 not-ready for expired token, got %d", w.Code)
	}
}

// P2: accept the nested {tokens:{access,refresh}} shizuha-id login shape.
func TestPasswordMintNestedTokenShape(t *testing.T) {
	access := makeJWT(t, time.Now().Add(15*time.Minute).Unix())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tokens": map[string]string{"access": access, "refresh": "r-nested"},
			"user":   map[string]string{"username": "x"},
		})
	}))
	defer srv.Close()
	c := NewPasswordMintClient(srv.URL+"/login/", srv.URL+"/refresh/", "u", "p")
	sess, err := c.Login(context.Background())
	if err != nil {
		t.Fatalf("login (nested shape): %v", err)
	}
	if sess.Access != access || sess.Refresh != "r-nested" {
		t.Fatalf("nested shape not parsed: %+v", sess)
	}
}

// P2: a refresh response that omits a new refresh token must NOT blank the held
// one (else the minter does a full password login every cycle).
func TestMinterPreservesNonRotatingRefresh(t *testing.T) {
	fm := &fakeMint{
		loginResp:   AgentSession{Access: "jwt-1", Refresh: "r-1", Exp: time.Now().Add(10 * time.Minute)},
		refreshResp: AgentSession{Access: "jwt-2", Refresh: "", Exp: time.Now().Add(10 * time.Minute)},
	}
	sink := &fakeSink{}
	m := NewPasswordMinter(fm, sink, NewAuditEmitter(io.Discard), DefaultMinterConfig(), 5)
	ctx, cancel := context.WithCancel(context.Background())
	var sleeps int
	var smu sync.Mutex
	m.sleep = func(c context.Context, d time.Duration) bool {
		smu.Lock()
		sleeps++
		n := sleeps
		smu.Unlock()
		if n >= 3 {
			cancel()
			return false
		}
		return true
	}
	m.Run(ctx)
	if sink.count() < 2 {
		t.Fatalf("expected >=2 sessions, got %d", sink.count())
	}
	if sink.at(1).Refresh != "r-1" {
		t.Fatalf("non-rotating refresh not preserved: got %q want r-1", sink.at(1).Refresh)
	}
	if fm.refreshes != 1 {
		t.Fatalf("expected 1 refresh (not a fresh login), got %d refreshes / %d logins", fm.refreshes, fm.logins)
	}
}
