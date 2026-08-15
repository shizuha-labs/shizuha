package proxy

import (
	"context"
	"net/http"
	"sync"
	"time"
)

type UpstreamState struct {
	Name          string    `json:"name"`
	Healthy       bool      `json:"healthy"`
	Attempts      int       `json:"attempts"`
	LastError     string    `json:"last_error,omitempty"`
	LastCheckedAt time.Time `json:"last_checked_at,omitempty"`
}

type UpstreamManager struct {
	mu      sync.Mutex
	states  map[string]UpstreamState
	max     int
	backoff time.Duration
	audit   *AuditEmitter
}

func NewUpstreamManager(names []string, max int, backoff time.Duration, audit *AuditEmitter) *UpstreamManager {
	states := map[string]UpstreamState{}
	for _, n := range names {
		states[n] = UpstreamState{Name: n}
	}
	return &UpstreamManager{states: states, max: max, backoff: backoff, audit: audit}
}

func (u *UpstreamManager) Health() []UpstreamState {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := make([]UpstreamState, 0, len(u.states))
	for _, s := range u.states {
		out = append(out, s)
	}
	return out
}

// AttributionSummary returns a name→healthy snapshot for use in refresh-grant
// audit events (ADR-PLAT-002 §5-INV-2a / PLAT-1065).
func (u *UpstreamManager) AttributionSummary() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := make(map[string]any, len(u.states))
	for name, s := range u.states {
		out[name] = map[string]any{"healthy": s.Healthy}
	}
	return out
}

func (u *UpstreamManager) CheckOnce(ctx context.Context, name string) UpstreamState {
	state := UpstreamState{Name: name, LastCheckedAt: time.Now().UTC()}
	client := &http.Client{Timeout: 2 * time.Second}
	for attempt := 1; attempt <= u.max; attempt++ {
		state.Attempts = attempt
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, name, nil)
		if reqErr != nil {
			// A scheme-less/malformed upstream entry yields a nil request;
			// dialing it would nil-deref and panic the health handler. Treat
			// construction failure as an unhealthy upstream: record it, emit a
			// transport-failed audit event, and continue the backoff loop.
			state.LastError = reqErr.Error()
			u.audit.Emit("transport-failed", map[string]any{"upstream": name, "attempt": attempt, "error": state.LastError})
			select {
			case <-ctx.Done():
				state.LastError = ctx.Err().Error()
				return state
			case <-time.After(u.backoff * time.Duration(attempt)):
			}
			continue
		}
		resp, err := client.Do(req)
		if err == nil && resp.StatusCode < 500 {
			_ = resp.Body.Close()
			state.Healthy = true
			state.LastError = ""
			break
		}
		if err != nil {
			state.LastError = err.Error()
		} else {
			state.LastError = resp.Status
			_ = resp.Body.Close()
		}
		u.audit.Emit("transport-failed", map[string]any{"upstream": name, "attempt": attempt, "error": state.LastError})
		select {
		case <-ctx.Done():
			state.LastError = ctx.Err().Error()
			return state
		case <-time.After(u.backoff * time.Duration(attempt)):
		}
	}
	if !state.Healthy {
		u.audit.Emit("mcp-unavailable", map[string]any{"upstream": name, "attempts": state.Attempts, "error": state.LastError})
	}
	u.mu.Lock()
	u.states[name] = state
	u.mu.Unlock()
	return state
}
