package proxy

import (
	"context"
	"math/rand"
	"sync"
	"time"
)

// passwordMinter is the dependency the lifecycle needs; *PasswordMintClient
// satisfies it. Kept small so the loop is testable with a fake.
type passwordMinter interface {
	Login(ctx context.Context) (AgentSession, error)
	Refresh(ctx context.Context, refresh string) (AgentSession, error)
}

// sessionSink receives each freshly minted/refreshed session. *Server implements
// it (SetAgentSession), so the agent's GET /token hand-off always returns the
// current JWT.
type sessionSink interface {
	SetAgentSession(AgentSession)
}

// errorSink is an optional extension of sessionSink: if the sink also
// implements this, the minter records each mint failure reason so callers can
// surface WHY /token is not ready (SCLI-154). *Server implements it.
type errorSink interface {
	SetLastMintError(string)
}

// rateLimiter is a token bucket bounding mint/refresh attempts. Per
// ADR-PLAT-002 §4-INV-5/§4-INV-6, a fleet reschedule (node drain) re-mints many
// agents at once — a thundering herd on shizuha-id. Per-sidecar jitter spreads
// the timing; this bucket caps a single sidecar's retry storm so a flapping
// shizuha-id can't be hammered.
type rateLimiter struct {
	mu        sync.Mutex
	tokens    float64
	max       float64
	perSecond float64
	last      time.Time
	now       func() time.Time
}

func newRateLimiter(max, perSecond float64, now func() time.Time) *rateLimiter {
	return &rateLimiter{tokens: max, max: max, perSecond: perSecond, last: now(), now: now}
}

// allow refills by elapsed time and takes one token if available.
func (r *rateLimiter) allow() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	t := r.now()
	r.tokens += t.Sub(r.last).Seconds() * r.perSecond
	if r.tokens > r.max {
		r.tokens = r.max
	}
	r.last = t
	if r.tokens >= 1 {
		r.tokens--
		return true
	}
	return false
}

// MinterConfig tunes the mint/refresh lifecycle.
type MinterConfig struct {
	RefreshSkew   time.Duration // refresh this long before the JWT exp
	DefaultTTL    time.Duration // refresh cadence when exp is unknown
	StartupJitter time.Duration // max random initial delay (anti-herd)
	RefreshJitter time.Duration // max random +/- around each scheduled refresh
	BackoffBase   time.Duration // base backoff after a failed attempt
	BackoffMax    time.Duration // cap on backoff
	RateMax       float64       // token bucket size
	RatePerSecond float64       // token bucket refill rate
}

func DefaultMinterConfig() MinterConfig {
	return MinterConfig{
		RefreshSkew:   60 * time.Second,
		DefaultTTL:    5 * time.Minute,
		StartupJitter: 5 * time.Second,
		RefreshJitter: 10 * time.Second,
		BackoffBase:   2 * time.Second,
		BackoffMax:    2 * time.Minute,
		RateMax:       5,
		RatePerSecond: 0.2, // ~1 mint / 5s sustained
	}
}

// PasswordMinter owns the background lifecycle: an initial jittered login, then
// refresh-before-expiry, with rate-limiting + jittered backoff on failure. It
// never logs the password or token bytes (audit events carry only metadata).
type PasswordMinter struct {
	client           passwordMinter
	sink             sessionSink
	errSink          errorSink // optional; set when sink also implements errorSink (SCLI-154)
	audit            *AuditEmitter
	cfg              MinterConfig
	limiter          *rateLimiter
	now              func() time.Time
	sleep            func(context.Context, time.Duration) bool // injectable for tests
	rnd              *rand.Rand
	mu               sync.Mutex
	upstreamAttribFn func() map[string]any // PLAT-1065: optional; returns upstream attribution summary for refresh-grant events
}

func NewPasswordMinter(client passwordMinter, sink sessionSink, audit *AuditEmitter, cfg MinterConfig, seed int64) *PasswordMinter {
	now := time.Now
	m := &PasswordMinter{
		client:  client,
		sink:    sink,
		audit:   audit,
		cfg:     cfg,
		limiter: newRateLimiter(cfg.RateMax, cfg.RatePerSecond, now),
		now:     now,
		sleep:   ctxSleep,
		rnd:     rand.New(rand.NewSource(seed)),
		mu:      sync.Mutex{},
	}
	if es, ok := sink.(errorSink); ok {
		m.errSink = es
	}
	return m
}

// SetUpstreamAttributionFn wires in the proxy-layer attribution provider
// (ADR-PLAT-002 §5-INV-2a / PLAT-1065). When set, refresh-grant audit events
// carry upstream_attribution_summary sourced from this fn, not from id-core.
func (m *PasswordMinter) SetUpstreamAttributionFn(fn func() map[string]any) {
	m.mu.Lock()
	m.upstreamAttribFn = fn
	m.mu.Unlock()
}

// jitter returns a random duration in [0, max).
func (m *PasswordMinter) jitter(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return time.Duration(m.rnd.Int63n(int64(max)))
}

// Run drives the lifecycle until ctx is cancelled: startup jitter, then mint,
// then refresh-before-expiry; on failure it applies jittered exponential
// backoff (growing across consecutive failures) and falls back from refresh to
// a fresh login.
func (m *PasswordMinter) Run(ctx context.Context) {
	// Startup jitter: spread the herd when a node-drain restarts many sidecars
	// at once (ADR §4-INV-5).
	if !m.sleep(ctx, m.jitter(m.cfg.StartupJitter)) {
		return
	}
	var sess AgentSession
	have := false
	backoff := m.cfg.BackoffBase
	for {
		var next AgentSession
		var err error
		if have && sess.Refresh != "" {
			prevRefresh := sess.Refresh
			next, err = m.call(ctx, func() (AgentSession, error) {
				s, e := m.client.Refresh(ctx, prevRefresh)
				// Non-rotating refresh endpoints return only a new access token;
				// keep the existing refresh token so the next cycle refreshes
				// again instead of doing a full password login every time.
				if e == nil && s.Refresh == "" {
					s.Refresh = prevRefresh
				}
				return s, e
			}, "refresh")
		} else {
			next, err = m.call(ctx, func() (AgentSession, error) { return m.client.Login(ctx) }, "login")
		}
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			// Drop the held token from the sink once it has actually expired and we
			// still can't get a fresh one, so /token (and /readyz) stop reflecting a
			// stale JWT we can no longer refresh. A still-valid token is deliberately
			// retained through transient refresh blips (graceful degradation);
			// handleToken's expiry gate is the serve-path backstop. sess is zeroed so
			// the clear/audit fires once, not every failing iteration.
			if !sess.Exp.IsZero() && !m.now().Before(sess.Exp) {
				m.sink.SetAgentSession(AgentSession{})
				m.audit.Emit("jwt-cleared", map[string]any{"reason": "expired_unrefreshable"})
				sess = AgentSession{}
			}
			// Full-jitter exponential backoff (AWS-style): sleep in [0, backoff],
			// doubling across consecutive failures up to BackoffMax. On a refresh
			// failure, fall back to a fresh login next iteration.
			if !m.sleep(ctx, m.jitter(backoff+time.Nanosecond)) {
				return
			}
			backoff *= 2
			if backoff > m.cfg.BackoffMax {
				backoff = m.cfg.BackoffMax
			}
			have = false
			continue
		}
		backoff = m.cfg.BackoffBase // reset on success
		sess = next
		have = true
		m.sink.SetAgentSession(sess)
		m.audit.Emit("jwt-minted", map[string]any{"has_exp": !sess.Exp.IsZero(), "refresh_in_s": int(m.refreshDelay(sess) / time.Second)})
		if !m.sleep(ctx, m.refreshDelay(sess)) {
			return
		}
	}
}

// call runs fn once under the token-bucket rate limiter (waiting for a token if
// the bucket is empty), audits failures, and returns the result. Never logs
// token/password bytes.
func (m *PasswordMinter) call(ctx context.Context, fn func() (AgentSession, error), kind string) (AgentSession, error) {
	for !m.limiter.allow() {
		wait := time.Duration(float64(time.Second) / nonZero(m.cfg.RatePerSecond))
		if !m.sleep(ctx, wait+m.jitter(m.cfg.RefreshJitter)) {
			return AgentSession{}, ctx.Err()
		}
	}
	sess, err := fn()
	if err != nil {
		m.audit.Emit("mint-attempt-failed", map[string]any{"kind": kind, "error": err.Error()})
		if m.errSink != nil {
			m.errSink.SetLastMintError(err.Error())
		}
		return sess, err
	}
	// ADR-PLAT-002 §5-INV-2a (PLAT-1065): on a successful refresh-grant the
	// sidecar — not id-core — emits the upstream attribution. upstream_id / the
	// attribution summary come from the proxy-layer context, never forwarded from
	// shizuha-id.
	if kind == "refresh" {
		m.mu.Lock()
		fn := m.upstreamAttribFn
		m.mu.Unlock()
		var attrib map[string]any
		if fn != nil {
			attrib = fn()
		}
		m.audit.Emit("refresh-grant", map[string]any{
			"upstream_attribution_summary": attrib,
		})
	}
	return sess, err
}

// refreshDelay computes when to refresh: exp - skew, jittered, floored at a small
// minimum; falls back to DefaultTTL when exp is unknown.
func (m *PasswordMinter) refreshDelay(sess AgentSession) time.Duration {
	var base time.Duration
	if sess.Exp.IsZero() {
		base = m.cfg.DefaultTTL
	} else {
		base = sess.Exp.Sub(m.now()) - m.cfg.RefreshSkew
	}
	if base < time.Second {
		base = time.Second
	}
	// +/- jitter around the scheduled refresh (anti-herd on synchronized expiry).
	j := m.jitter(m.cfg.RefreshJitter)
	if base > j {
		base -= j / 2
	}
	return base
}

func nonZero(f float64) float64 {
	if f <= 0 {
		return 1
	}
	return f
}

// ctxSleep sleeps for d or until ctx is done; returns false if ctx was cancelled.
func ctxSleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
