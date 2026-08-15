package proxy

// HIVE-146: broker GET /model-token UDS endpoint.
//
// The bridge client (claude-bridge) calls GET /model-token?provider=<p> on the
// per-agent UDS instead of reading a baked CLAUDE_CODE_OAUTH_TOKEN from env.
// This handler gates on SO_PEERCRED (same gate as /token), then delegates to the
// hive coordinator (POST /hive/api/v1/coordinator/model-token) which picks the
// best active entry from the caller-owner pool and issues a single-use lease.
// The coordinator response {token, label, lease_expires_at} is relayed as
// {token, label, expires_at} — only the lease_expires_at rename is needed.
// Token bytes are never logged.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// coordinatorModelTokenRequest is the body sent to POST /v1/coordinator/model-token.
type coordinatorModelTokenRequest struct {
	Provider         string `json:"provider"`
	ForceRefresh     bool   `json:"force_refresh,omitempty"`
	PreferredEntryID string `json:"preferred_entry_id,omitempty"`
	ExcludeEntryID   string `json:"exclude_entry_id,omitempty"`
	StickyKey        string `json:"sticky_key,omitempty"`
}

// coordinatorModelTokenResponse is the subset of fields the coordinator returns
// that the broker needs to relay to the bridge client.
type coordinatorModelTokenResponse struct {
	Token          string `json:"token"`
	Label          string `json:"label"`
	EntryID        string `json:"entry_id"`
	LeaseID        string `json:"lease_id"`
	LeaseExpiresAt string `json:"lease_expires_at"`
}

type coordinatorModelTokenStatusRequest struct {
	EntryID         string `json:"entry_id"`
	LeaseID         string `json:"lease_id"`
	Action          string `json:"action"`
	CooldownSeconds int    `json:"cooldown_seconds,omitempty"`
}

// fetchModelTokenFromCoordinator calls the hive coordinator and returns the
// model token for provider p, or an error. The bearer token must carry
// aud=hive-coordinator + scope=coordinator:model-token (HIVE-127 broker gate).
func fetchModelTokenFromCoordinator(
	ctx context.Context,
	coordinatorURL,
	bearerToken,
	provider string,
	forceRefresh bool,
	preferredEntryID,
	excludeEntryID,
	stickyKey string,
) (coordinatorModelTokenResponse, error) {
	body, err := json.Marshal(coordinatorModelTokenRequest{
		Provider:         provider,
		ForceRefresh:     forceRefresh,
		PreferredEntryID: preferredEntryID,
		ExcludeEntryID:   excludeEntryID,
		StickyKey:        stickyKey,
	})
	if err != nil {
		return coordinatorModelTokenResponse{}, fmt.Errorf("marshal: %w", err)
	}

	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, coordinatorURL, bytes.NewReader(body))
	if err != nil {
		return coordinatorModelTokenResponse{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearerToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return coordinatorModelTokenResponse{}, fmt.Errorf("coordinator request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return coordinatorModelTokenResponse{}, fmt.Errorf("coordinator HTTP %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if err != nil {
		return coordinatorModelTokenResponse{}, fmt.Errorf("read response: %w", err)
	}

	var result coordinatorModelTokenResponse
	if err := json.Unmarshal(raw, &result); err != nil {
		return coordinatorModelTokenResponse{}, fmt.Errorf("unmarshal: %w", err)
	}
	if result.Token == "" {
		return coordinatorModelTokenResponse{}, fmt.Errorf("coordinator returned empty token")
	}
	if result.EntryID == "" || result.LeaseID == "" {
		return coordinatorModelTokenResponse{}, fmt.Errorf("coordinator returned token without lease metadata")
	}
	return result, nil
}

func reportModelTokenStatusToCoordinator(ctx context.Context, coordinatorURL, bearerToken string, status coordinatorModelTokenStatusRequest) error {
	body, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	reportURL := strings.TrimRight(coordinatorURL, "/")
	reportURL = strings.TrimSuffix(reportURL, "/model-token") + "/report-status"

	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, reportURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearerToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("coordinator request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("coordinator HTTP %d", resp.StatusCode)
	}
	return nil
}

// handleModelToken serves GET /model-token?provider=<p> over the UDS.
//
// Identity gate: SO_PEERCRED (identical to /token — agent UID must match).
// Coordinator required: 503 if MCP_AUTH_PROXY_COORDINATOR_URL is not configured.
func (s *Server) handleModelToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	// --- SO_PEERCRED identity gate (mirrors handleToken) ---
	peer, ok := PeerCredFromContext(r.Context())
	if !ok {
		s.audit.Emit("identity-mismatch", map[string]any{
			"failure_class": "tier1_peercred_fail",
			"endpoint":      "/model-token",
			"error":         "SO_PEERCRED unavailable",
		})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer credentials unavailable"})
		return
	}
	if s.cfg.ExpectedAgentUID == nil {
		s.audit.Emit("model-token-refused", map[string]any{
			"failure_class": "expected_uid_unconfigured",
			"endpoint":      "/model-token",
			"uid":           peer.UID,
		})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "model-token endpoint disabled: expected agent uid not configured"})
		return
	}
	if peer.UID != *s.cfg.ExpectedAgentUID {
		s.audit.Emit("identity-mismatch", map[string]any{
			"failure_class": "tier1_peercred_fail",
			"endpoint":      "/model-token",
			"uid":           peer.UID,
			"expected_uid":  *s.cfg.ExpectedAgentUID,
		})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer uid mismatch"})
		return
	}

	// --- coordinator availability check ---
	if s.cfg.CoordinatorURL == "" {
		s.audit.Emit("model-token-refused", map[string]any{"failure_class": "coordinator_unconfigured", "uid": peer.UID})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "model-token endpoint disabled: coordinator not configured"})
		return
	}

	// --- provider from query param (default: anthropic) ---
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	if provider == "" {
		provider = "anthropic"
	}
	forceRefresh := r.URL.Query().Get("force_refresh") == "1" ||
		strings.EqualFold(r.URL.Query().Get("force_refresh"), "true")
	preferredEntryID := strings.TrimSpace(r.URL.Query().Get("preferred_entry_id"))
	excludeEntryID := strings.TrimSpace(r.URL.Query().Get("exclude_entry_id"))
	stickyKey := strings.TrimSpace(r.URL.Query().Get("sticky_key"))

	// --- fetch from coordinator ---
	result, err := fetchModelTokenFromCoordinator(
		r.Context(),
		s.cfg.CoordinatorURL,
		s.cfg.CoordinatorBearerToken,
		provider,
		forceRefresh,
		preferredEntryID,
		excludeEntryID,
		stickyKey,
	)
	if err != nil {
		s.audit.Emit("model-token-refused", map[string]any{
			"failure_class": "coordinator_error",
			"uid":           peer.UID,
			"provider":      provider,
			"error":         err.Error(),
		})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "model token unavailable"})
		return
	}

	// Map lease_expires_at → expires_at for the bridge contract (BrokerModelToken shape).
	resp := map[string]any{
		"token":      result.Token,
		"label":      result.Label,
		"entry_id":   result.EntryID,
		"lease_id":   result.LeaseID,
		"expires_at": result.LeaseExpiresAt,
	}
	// Audit metadata only — never token bytes.
	s.audit.Emit("model-token-served", map[string]any{"uid": peer.UID, "provider": provider, "label": result.Label})
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleModelTokenReportStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	peer, ok := PeerCredFromContext(r.Context())
	if !ok {
		s.audit.Emit("identity-mismatch", map[string]any{
			"failure_class": "tier1_peercred_fail",
			"endpoint":      "/model-token/report-status",
			"error":         "SO_PEERCRED unavailable",
		})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer credentials unavailable"})
		return
	}
	if s.cfg.ExpectedAgentUID == nil {
		s.audit.Emit("model-token-report-refused", map[string]any{
			"failure_class": "expected_uid_unconfigured",
			"endpoint":      "/model-token/report-status",
			"uid":           peer.UID,
		})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "model-token report endpoint disabled: expected agent uid not configured"})
		return
	}
	if peer.UID != *s.cfg.ExpectedAgentUID {
		s.audit.Emit("identity-mismatch", map[string]any{
			"failure_class": "tier1_peercred_fail",
			"endpoint":      "/model-token/report-status",
			"uid":           peer.UID,
			"expected_uid":  *s.cfg.ExpectedAgentUID,
		})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer uid mismatch"})
		return
	}
	if s.cfg.CoordinatorURL == "" {
		s.audit.Emit("model-token-report-refused", map[string]any{"failure_class": "coordinator_unconfigured", "uid": peer.UID})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "model-token report endpoint disabled: coordinator not configured"})
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid body"})
		return
	}
	var status coordinatorModelTokenStatusRequest
	if err := json.Unmarshal(raw, &status); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if status.EntryID == "" || status.LeaseID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "entry_id and lease_id are required"})
		return
	}
	if status.Action == "" {
		status.Action = "cool"
	}
	if status.Action != "cool" && status.Action != "deactivate" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid action"})
		return
	}

	if err := reportModelTokenStatusToCoordinator(r.Context(), s.cfg.CoordinatorURL, s.cfg.CoordinatorBearerToken, status); err != nil {
		s.audit.Emit("model-token-report-refused", map[string]any{
			"failure_class": "coordinator_error",
			"uid":           peer.UID,
			"entry_id":      status.EntryID,
			"lease_id":      status.LeaseID,
			"action":        status.Action,
			"error":         err.Error(),
		})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "model token status report unavailable"})
		return
	}
	s.audit.Emit("model-token-status-reported", map[string]any{
		"uid":      peer.UID,
		"entry_id": status.EntryID,
		"lease_id": status.LeaseID,
		"action":   status.Action,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
