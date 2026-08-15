package proxy

import (
	"context"
	"errors"
	"math/rand"
	"os"
	"strings"
	"sync"
	"time"
)

// bootstrapSessionSink receives successful SA-token bootstrap sessions. *Server
// implements it; the interface keeps the retry loop testable without serving a
// real UDS. Token bytes are held only by the server sink and never audited.
type bootstrapSessionSink interface {
	SetBootstrapSession(MintResponse, IdentityTuple)
}

// BootstrapRetryConfig tunes the legacy SA-token bootstrap recovery loop.
type BootstrapRetryConfig struct {
	SATokenPath      string
	TokenAudience    string
	ClaimedAgentID   string
	ExpectedAgentUID *uint32
	BackoffBase      time.Duration
	BackoffMax       time.Duration
}

func DefaultBootstrapRetryConfig() BootstrapRetryConfig {
	return BootstrapRetryConfig{
		BackoffBase: 2 * time.Second,
		BackoffMax:  2 * time.Minute,
	}
}

// BootstrapRetrier retries SA-token bootstrap after transient TokenReview/mint
// failures. This is the self-heal path for PLAT-1173: the agent may have tried
// POST /bootstrap once while the projected SA token or shizuha-id was not ready;
// the sidecar must re-read the projected token and retry with backoff instead
// of sitting forever at /readyz {bootstrapped:false,has_token:false}.
type BootstrapRetrier struct {
	reviewer TokenReviewer
	mint     MintClient
	sink     bootstrapSessionSink
	audit    *AuditEmitter
	cfg      BootstrapRetryConfig
	now      func() time.Time
	sleep    func(context.Context, time.Duration) bool
	rnd      *rand.Rand
	mu       sync.Mutex
}

func NewBootstrapRetrier(reviewer TokenReviewer, mint MintClient, sink bootstrapSessionSink, audit *AuditEmitter, cfg BootstrapRetryConfig, seed int64) *BootstrapRetrier {
	if cfg.BackoffBase <= 0 {
		cfg.BackoffBase = DefaultBootstrapRetryConfig().BackoffBase
	}
	if cfg.BackoffMax <= 0 {
		cfg.BackoffMax = DefaultBootstrapRetryConfig().BackoffMax
	}
	return &BootstrapRetrier{
		reviewer: reviewer,
		mint:     mint,
		sink:     sink,
		audit:    audit,
		cfg:      cfg,
		now:      time.Now,
		sleep:    ctxSleep,
		rnd:      rand.New(rand.NewSource(seed)),
	}
}

func (b *BootstrapRetrier) Run(ctx context.Context) {
	backoff := b.cfg.BackoffBase
	for {
		if err := b.tryOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			b.audit.Emit("bootstrap-retry-failed", map[string]any{"error": err.Error()})
			if !b.sleep(ctx, b.jitter(backoff+time.Nanosecond)) {
				return
			}
			backoff *= 2
			if backoff > b.cfg.BackoffMax {
				backoff = b.cfg.BackoffMax
			}
			continue
		}
		return
	}
}

func (b *BootstrapRetrier) tryOnce(ctx context.Context) error {
	tokenPath := strings.TrimSpace(b.cfg.SATokenPath)
	if tokenPath == "" {
		return errors.New("bootstrap retry disabled: serviceaccount token path is empty")
	}
	tokenBytes, err := os.ReadFile(tokenPath)
	if err != nil {
		return err
	}
	saToken := strings.TrimSpace(string(tokenBytes))
	tr, err := b.reviewer.Review(ctx, saToken, b.cfg.TokenAudience)
	if err != nil {
		return err
	}
	if !tr.Authenticated {
		return errors.New("tokenreview unauthenticated")
	}
	uid := uint32(0)
	if b.cfg.ExpectedAgentUID != nil {
		uid = *b.cfg.ExpectedAgentUID
	}
	identity := IdentityTuple{UID: uid, SANamespace: tr.SANamespace, SAName: tr.SAName, PodName: tr.PodName}
	if identity.SANamespace == "" || identity.SAName == "" || identity.PodName == "" {
		return errors.New("tokenreview missing pod-bound identity tuple")
	}
	minted, err := b.mint.Mint(ctx, MintRequest{SAToken: saToken, ClaimedAgentID: b.cfg.ClaimedAgentID, Identity: identity})
	if err != nil {
		return err
	}
	b.sink.SetBootstrapSession(minted, identity)
	b.audit.Emit("bootstrap-retry-succeeded", map[string]any{"agent_id": minted.AgentID, "uid": identity.UID, "sa_namespace": identity.SANamespace, "sa_name": identity.SAName, "pod_name": identity.PodName, "expires_in": minted.ExpiresIn})
	return nil
}

func (b *BootstrapRetrier) jitter(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return time.Duration(b.rnd.Int63n(int64(max)))
}
