package proxy

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type retryTokenReviewer struct {
	mu     sync.Mutex
	tokens []string
}

func (r *retryTokenReviewer) Review(_ context.Context, token, audience string) (TokenReviewResult, error) {
	r.mu.Lock()
	r.tokens = append(r.tokens, token+":"+audience)
	r.mu.Unlock()
	if token != "fresh-sa-token" {
		return TokenReviewResult{}, errors.New("tokenreview rejected")
	}
	return TokenReviewResult{Authenticated: true, SANamespace: "rt-ni", SAName: "agent-runtime", PodName: "ni-0"}, nil
}

func (r *retryTokenReviewer) seen() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.tokens...)
}

type retryMintClient struct {
	mu       sync.Mutex
	requests []MintRequest
}

func (m *retryMintClient) Mint(_ context.Context, req MintRequest) (MintResponse, error) {
	m.mu.Lock()
	m.requests = append(m.requests, req)
	m.mu.Unlock()
	return MintResponse{AgentID: req.ClaimedAgentID, SessionToken: "minted-session", ExpiresIn: 300}, nil
}

type retrySink struct {
	mu       sync.Mutex
	sessions []MintResponse
	ids      []IdentityTuple
}

func (s *retrySink) SetBootstrapSession(sess MintResponse, identity IdentityTuple) {
	s.mu.Lock()
	s.sessions = append(s.sessions, sess)
	s.ids = append(s.ids, identity)
	s.mu.Unlock()
}

func (s *retrySink) last() (MintResponse, IdentityTuple, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) == 0 {
		return MintResponse{}, IdentityTuple{}, false
	}
	return s.sessions[len(s.sessions)-1], s.ids[len(s.ids)-1], true
}

func TestBootstrapRetrierRereadsSATokenAndRecovers(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("stale-sa-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var audit bytes.Buffer
	reviewer := &retryTokenReviewer{}
	mint := &retryMintClient{}
	sink := &retrySink{}
	uid := uint32(1000)
	r := NewBootstrapRetrier(reviewer, mint, sink, NewAuditEmitter(&audit), BootstrapRetryConfig{
		SATokenPath:      tokenPath,
		TokenAudience:    "shizuha-mcp-auth-proxy",
		ClaimedAgentID:   "ni",
		ExpectedAgentUID: &uid,
		BackoffBase:      time.Millisecond,
		BackoffMax:       time.Millisecond,
	}, 1)
	var sleeps int
	r.sleep = func(context.Context, time.Duration) bool {
		sleeps++
		if sleeps == 1 {
			if err := os.WriteFile(tokenPath, []byte("fresh-sa-token\n"), 0o600); err != nil {
				t.Fatalf("rewrite token: %v", err)
			}
		}
		return true
	}
	r.Run(context.Background())

	seen := reviewer.seen()
	if len(seen) != 2 || seen[0] != "stale-sa-token:shizuha-mcp-auth-proxy" || seen[1] != "fresh-sa-token:shizuha-mcp-auth-proxy" {
		t.Fatalf("expected stale then fresh TokenReview attempts, got %#v", seen)
	}
	sess, identity, ok := sink.last()
	if !ok || sess.AgentID != "ni" || sess.SessionToken == "" {
		t.Fatalf("expected bootstrapped session for ni, got ok=%v sess=%+v", ok, sess)
	}
	if identity.UID != uid || identity.SANamespace != "rt-ni" || identity.PodName != "ni-0" {
		t.Fatalf("unexpected identity: %+v", identity)
	}
	if log := audit.String(); !strings.Contains(log, `"event":"bootstrap-retry-failed"`) || !strings.Contains(log, `"event":"bootstrap-retry-succeeded"`) {
		t.Fatalf("expected failure and success audit events, got:\n%s", log)
	}
}
