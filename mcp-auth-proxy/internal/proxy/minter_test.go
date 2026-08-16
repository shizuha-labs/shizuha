package proxy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math/rand"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeMint struct {
	mu          sync.Mutex
	loginResp   AgentSession
	refreshResp AgentSession
	loginErr    error
	refreshErr  error
	logins      int
	refreshes   int
}

func (f *fakeMint) Login(context.Context) (AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logins++
	return f.loginResp, f.loginErr
}
func (f *fakeMint) Refresh(context.Context, string) (AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refreshes++
	return f.refreshResp, f.refreshErr
}

type fakeSink struct {
	mu       sync.Mutex
	sessions []AgentSession
}

func (s *fakeSink) SetAgentSession(a AgentSession) {
	s.mu.Lock()
	s.sessions = append(s.sessions, a)
	s.mu.Unlock()
}
func (s *fakeSink) count() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.sessions) }
func (s *fakeSink) at(i int) AgentSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[i]
}

func TestRateLimiter(t *testing.T) {
	now := time.Unix(1000, 0)
	clock := func() time.Time { return now }
	rl := newRateLimiter(2, 1, clock) // 2 burst, 1/s refill
	if !rl.allow() || !rl.allow() {
		t.Fatal("first two allows should succeed (burst=2)")
	}
	if rl.allow() {
		t.Fatal("third allow should fail (bucket empty)")
	}
	now = now.Add(1 * time.Second) // refill 1 token
	if !rl.allow() {
		t.Fatal("after 1s, one token should be available")
	}
	if rl.allow() {
		t.Fatal("bucket should be empty again")
	}
}

func TestPasswordMinterLoginThenRefresh(t *testing.T) {
	fm := &fakeMint{
		loginResp:   AgentSession{Access: "jwt-1", Refresh: "r-1", Exp: time.Now().Add(10 * time.Minute)},
		refreshResp: AgentSession{Access: "jwt-2", Refresh: "r-2", Exp: time.Now().Add(10 * time.Minute)},
	}
	sink := &fakeSink{}
	m := NewPasswordMinter(fm, sink, NewAuditEmitter(io.Discard), DefaultMinterConfig(), 42)

	// Deterministic loop control: count sleeps, cancel after the 3rd (startup,
	// post-login, post-refresh→stop) so we observe exactly login then refresh.
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
	m.rnd = rand.New(rand.NewSource(1))

	m.Run(ctx)

	if fm.logins != 1 {
		t.Fatalf("expected exactly 1 login, got %d", fm.logins)
	}
	if fm.refreshes != 1 {
		t.Fatalf("expected exactly 1 refresh, got %d", fm.refreshes)
	}
	if sink.count() != 2 {
		t.Fatalf("expected 2 sessions handed off, got %d", sink.count())
	}
	if sink.at(0).Access != "jwt-1" || sink.at(1).Access != "jwt-2" {
		t.Fatalf("unexpected session order: %q then %q", sink.at(0).Access, sink.at(1).Access)
	}
}

// P2 (review, minter.go): once the held token has actually expired and refresh
// keeps failing, the minter must drop it from the sink so /token and /readyz stop
// reflecting a stale JWT it can no longer refresh. (A still-valid token through a
// transient blip is retained — covered by TestPasswordMinterLoginThenRefresh.)
func TestMinterClearsExpiredUnrefreshableToken(t *testing.T) {
	base := time.Unix(1_000_000, 0)
	fm := &fakeMint{
		// Login succeeds once (hands off jwt-1) with a token already at its exp;
		// refresh then always fails, so the held token can never be renewed.
		loginResp:  AgentSession{Access: "jwt-1", Refresh: "r-1", Exp: base},
		refreshErr: errors.New("shizuha-id unreachable"),
	}
	sink := &fakeSink{}
	m := NewPasswordMinter(fm, sink, NewAuditEmitter(io.Discard), DefaultMinterConfig(), 9)
	m.now = func() time.Time { return base.Add(time.Hour) } // well past exp
	ctx, cancel := context.WithCancel(context.Background())
	var sleeps int
	var smu sync.Mutex
	m.sleep = func(c context.Context, d time.Duration) bool {
		smu.Lock()
		sleeps++
		n := sleeps
		smu.Unlock()
		if n >= 3 { // startup, post-login refreshDelay, post-failure backoff
			cancel()
			return false
		}
		return true
	}
	m.Run(ctx)
	if sink.count() < 2 {
		t.Fatalf("expected jwt-1 then a clear, got %d sessions", sink.count())
	}
	if first := sink.at(0); first.Access != "jwt-1" {
		t.Fatalf("expected jwt-1 handed off first, got %q", first.Access)
	}
	if last := sink.at(sink.count() - 1); last.Access != "" {
		t.Fatalf("expected sink cleared (empty Access) after expired+unrefreshable, got %q", last.Access)
	}
}

func TestRefreshDelayUsesExp(t *testing.T) {
	m := NewPasswordMinter(&fakeMint{}, &fakeSink{}, NewAuditEmitter(io.Discard), DefaultMinterConfig(), 7)
	base := time.Unix(100000, 0)
	m.now = func() time.Time { return base }
	// exp 10m out, skew 60s → ~9m, minus up-to-jitter; must be well under 10m and positive.
	d := m.refreshDelay(AgentSession{Exp: base.Add(10 * time.Minute)})
	if d <= 0 || d >= 10*time.Minute {
		t.Fatalf("refreshDelay out of range: %v", d)
	}
	// Unknown exp → DefaultTTL-ish (positive, <= DefaultTTL).
	d2 := m.refreshDelay(AgentSession{})
	if d2 <= 0 || d2 > DefaultMinterConfig().DefaultTTL {
		t.Fatalf("default refreshDelay out of range: %v", d2)
	}
}

// TestMintBurstJitterSpread simulates a node-drain (HLD M3 / ADR §4-INV-5/6):
// many sidecars start their minter at once and MUST spread their first mint
// across the startup-jitter window, not thunder shizuha-id simultaneously.
// PLAT-1065 / ADR-PLAT-002 §5-INV-2a: on a successful token refresh the sidecar
// MUST emit a "refresh-grant" audit event carrying upstream_attribution_summary
// sourced from the proxy layer (not id-core). A login MUST NOT emit this event.
func TestRefreshGrantAuditEmittedOnRefreshNotLogin(t *testing.T) {
	var audit bytes.Buffer
	fm := &fakeMint{
		loginResp:   AgentSession{Access: "jwt-1", Refresh: "r-1", Exp: time.Now().Add(10 * time.Minute)},
		refreshResp: AgentSession{Access: "jwt-2", Refresh: "r-2", Exp: time.Now().Add(10 * time.Minute)},
	}
	sink := &fakeSink{}
	m := NewPasswordMinter(fm, sink, NewAuditEmitter(&audit), DefaultMinterConfig(), 42)
	// Inject proxy-layer attribution; verifies that call() uses this fn, not id-core.
	m.SetUpstreamAttributionFn(func() map[string]any {
		return map[string]any{"pulse": map[string]any{"healthy": true}}
	})

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
	m.rnd = rand.New(rand.NewSource(1))
	m.Run(ctx)

	log := audit.String()
	// "refresh-grant" must appear exactly once (one refresh cycle).
	grantCount := strings.Count(log, `"refresh-grant"`)
	if grantCount != 1 {
		t.Errorf("expected exactly 1 refresh-grant event, got %d; log:\n%s", grantCount, log)
	}
	// upstream_attribution_summary must be present.
	if !strings.Contains(log, `"upstream_attribution_summary"`) {
		t.Errorf("refresh-grant event missing upstream_attribution_summary; log:\n%s", log)
	}
	// proxy-injected upstream name must be in the audit log.
	if !strings.Contains(log, `"pulse"`) {
		t.Errorf("refresh-grant event missing proxy-layer attribution key 'pulse'; log:\n%s", log)
	}
	// login must NOT emit a refresh-grant event (jwt-minted only).
	loginOnlyLines := strings.Split(log, "\n")
	for _, line := range loginOnlyLines {
		if strings.Contains(line, `"refresh-grant"`) && strings.Contains(line, `"jwt-1"`) {
			t.Errorf("refresh-grant emitted for initial login, not just refresh; log:\n%s", log)
		}
	}
}

// PLAT-1065: when no upstream attribution fn is wired (e.g. in unit tests), the
// refresh-grant event still emits with a null attribution — no panic, no missing event.
func TestRefreshGrantEmittedWithNilAttributionFn(t *testing.T) {
	var audit bytes.Buffer
	fm := &fakeMint{
		loginResp:   AgentSession{Access: "jwt-1", Refresh: "r-1", Exp: time.Now().Add(10 * time.Minute)},
		refreshResp: AgentSession{Access: "jwt-2", Refresh: "r-2", Exp: time.Now().Add(10 * time.Minute)},
	}
	sink := &fakeSink{}
	// No SetUpstreamAttributionFn — upstreamAttribFn remains nil.
	m := NewPasswordMinter(fm, sink, NewAuditEmitter(&audit), DefaultMinterConfig(), 7)
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
	m.rnd = rand.New(rand.NewSource(3))
	m.Run(ctx)

	log := audit.String()
	if !strings.Contains(log, `"refresh-grant"`) {
		t.Errorf("refresh-grant event missing even without attribution fn; log:\n%s", log)
	}
	if !strings.Contains(log, `"upstream_attribution_summary"`) {
		t.Errorf("refresh-grant event missing upstream_attribution_summary key; log:\n%s", log)
	}
}

func TestMintBurstJitterSpread(t *testing.T) {
	const n = 60
	cfg := DefaultMinterConfig() // StartupJitter = 5s
	buckets := map[int]int{}     // 1s bucket -> count
	for i := 0; i < n; i++ {
		m := NewPasswordMinter(&fakeMint{}, &fakeSink{}, NewAuditEmitter(io.Discard), cfg, int64(i*7+1))
		d := m.jitter(cfg.StartupJitter)
		if d < 0 || d >= cfg.StartupJitter {
			t.Fatalf("startup jitter out of range: %v", d)
		}
		buckets[int(d/time.Second)]++
	}
	windowSecs := int(cfg.StartupJitter / time.Second)
	if len(buckets) < windowSecs-1 {
		t.Fatalf("startup jitter too clustered: %d/%d 1s-buckets used (thundering-herd risk)", len(buckets), windowSecs)
	}
	for b, c := range buckets {
		if c > n/2 {
			t.Fatalf("bucket %ds holds %d/%d minters — not spread (herd risk)", b, c, n)
		}
	}
}
