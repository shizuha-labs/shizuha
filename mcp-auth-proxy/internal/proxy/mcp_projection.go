package proxy

// PLAT-5275: broker relay for the Hive-authoritative MCP scope projection.
//
// The broker never caches, interprets, or signs projections. It authenticates
// the local child with SO_PEERCRED, relays the fresh nonce to Hive using only the
// broker-held coordinator credential, and streams the signed canonical envelope
// back. The child still verifies Ed25519 against its immutable read-only trust
// root: the UDS is transport, not authority.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type mcpProjectionRequest struct {
	Nonce string `json:"nonce"`
}

var projectionNoncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func fetchMCPProjection(ctx context.Context, projectionURL, bearerToken, nonce string) ([]byte, error) {
	body, err := json.Marshal(mcpProjectionRequest{Nonce: nonce})
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}
	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, projectionURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearerToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("projection request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("projection HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10+1))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if len(raw) == 0 || len(raw) > 64<<10 {
		return nil, fmt.Errorf("projection response size invalid")
	}
	return raw, nil
}

func (s *Server) handleMCPProjection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	peer, ok := PeerCredFromContext(r.Context())
	if !ok || s.cfg.ExpectedAgentUID == nil || peer.UID != *s.cfg.ExpectedAgentUID {
		s.audit.Emit("mcp-projection-refused", map[string]any{"failure_class": "peer_identity", "endpoint": "/mcp-projection"})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "projection caller identity refused"})
		return
	}
	if strings.TrimSpace(s.cfg.ProjectionURL) == "" || strings.TrimSpace(s.cfg.CoordinatorBearerToken) == "" {
		s.audit.Emit("mcp-projection-refused", map[string]any{"failure_class": "producer_unconfigured", "uid": peer.UID})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "projection producer unavailable"})
		return
	}
	var input mcpProjectionRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || !projectionNoncePattern.MatchString(input.Nonce) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid projection challenge"})
		return
	}
	projectionURL := strings.ReplaceAll(s.cfg.ProjectionURL, "{agent_id}", s.cfg.AgentID)
	if s.cfg.AgentID == "" || strings.Contains(projectionURL, "{agent_id}") {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "projection audience unavailable"})
		return
	}
	raw, err := fetchMCPProjection(r.Context(), projectionURL, s.cfg.CoordinatorBearerToken, input.Nonce)
	if err != nil {
		s.audit.Emit("mcp-projection-refused", map[string]any{"failure_class": "producer_refusal", "uid": peer.UID, "error": err.Error()})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "projection unavailable"})
		return
	}
	s.audit.Emit("mcp-projection-served", map[string]any{"uid": peer.UID})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}
