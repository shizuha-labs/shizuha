package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// PLAT-166 (HLD §5 / ADR-PLAT-002): credential-grant brokering over the pod-local
// UDS. Removing DinD removed the host Unix socket some agents used to fetch scoped
// credentials (github/docker/kubeconfig/...). This endpoint relays the agent's
// scoped credential request through the SAME SO_PEERCRED-gated sidecar socket that
// serves /token, so a grant is handed back over the pod-local socket and — per
// HLD §5 — is NEVER materialized as an environment variable.
//
// This file is the gated transport + broker seam. The actual relay to the platform
// credential system (mirroring src/daemon/credential-broker.ts: rate-limit,
// circuit-breaker, audit parity) is wired via the CredentialBroker interface and
// lands in a focused follow-up slice under the security review bar. Until then the
// default broker is fail-closed (denies every request), so this can ship without
// ever issuing an unreviewed grant.

// CredentialRequest is an agent's scoped request for a short-lived credential grant.
type CredentialRequest struct {
	Service    string `json:"service"`               // github | docker | kubeconfig | gcloud | aws
	Scope      string `json:"scope,omitempty"`       // service-specific scope (repo / registry / namespace)
	Reason     string `json:"reason,omitempty"`      // audit context
	TTLSeconds int    `json:"ttl_seconds,omitempty"` // requested lifetime (broker MAY clamp)
}

// CredentialGrant is the broker's response. Secret material lives in Data and is
// handed to the agent over the UDS only — it is NEVER logged or audited; audit
// records metadata exclusively.
type CredentialGrant struct {
	Service   string            `json:"service"`
	Scope     string            `json:"scope,omitempty"`
	Data      map[string]string `json:"data"`
	ExpiresAt time.Time         `json:"expires_at,omitempty"`
	RequestID string            `json:"request_id,omitempty"`
}

// CredentialBroker relays an authenticated agent's scoped request to the platform
// credential system. It is invoked ONLY after the SO_PEERCRED identity gate has
// authenticated the caller as the expected agent UID.
type CredentialBroker interface {
	RequestGrant(ctx context.Context, agentUID uint32, req CredentialRequest) (CredentialGrant, error)
}

// ErrCredentialBrokerUnconfigured signals that no real platform relay is wired yet;
// the endpoint maps it to 503 (vs. 403 for an authenticated-but-denied request).
var ErrCredentialBrokerUnconfigured = errors.New("credential broker not configured")

// denyAllBroker is the fail-closed default broker.
type denyAllBroker struct{}

func (denyAllBroker) RequestGrant(context.Context, uint32, CredentialRequest) (CredentialGrant, error) {
	return CredentialGrant{}, ErrCredentialBrokerUnconfigured
}

// knownCredentialServices bounds what an agent may request at the edge (defense in
// depth — the platform broker remains the authority).
var knownCredentialServices = map[string]bool{
	"github": true, "docker": true, "kubeconfig": true, "gcloud": true, "aws": true,
}

const maxCredentialRequestBytes = 16 << 10 // 16 KiB

// SetCredentialBroker installs the platform relay. Until set, the endpoint
// fail-closes (denyAllBroker).
func (s *Server) SetCredentialBroker(b CredentialBroker) {
	s.mu.Lock()
	s.credBroker = b
	s.mu.Unlock()
}

func (s *Server) credentialBroker() CredentialBroker {
	s.mu.RLock()
	b := s.credBroker
	s.mu.RUnlock()
	if b == nil {
		return denyAllBroker{}
	}
	return b
}

// handleCredentialRequest authenticates the caller via SO_PEERCRED (identical gate
// to /token) and relays the scoped credential request to the broker. The grant is
// returned over the UDS only; only metadata is ever audited.
func (s *Server) handleCredentialRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	// --- SO_PEERCRED identity gate (mirrors handleToken; fail closed) ---
	peer, ok := PeerCredFromContext(r.Context())
	if !ok {
		s.audit.Emit("identity-mismatch", map[string]any{"failure_class": "tier1_peercred_fail", "endpoint": "/credential/request", "error": "SO_PEERCRED unavailable"})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer credentials unavailable"})
		return
	}
	if s.cfg.ExpectedAgentUID == nil {
		s.audit.Emit("credential-refused", map[string]any{"failure_class": "expected_uid_unconfigured", "endpoint": "/credential/request", "uid": peer.UID})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "credential endpoint disabled: expected agent uid not configured"})
		return
	}
	if peer.UID != *s.cfg.ExpectedAgentUID {
		s.audit.Emit("identity-mismatch", map[string]any{"failure_class": "tier1_peercred_fail", "endpoint": "/credential/request", "uid": peer.UID, "expected_uid": *s.cfg.ExpectedAgentUID})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer uid mismatch"})
		return
	}

	// --- parse + validate the scoped request (bounded body, strict fields) ---
	var req CredentialRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxCredentialRequestBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid credential request body"})
		return
	}
	req.Service = strings.ToLower(strings.TrimSpace(req.Service))
	if req.Service == "" || !knownCredentialServices[req.Service] {
		s.audit.Emit("credential-refused", map[string]any{"failure_class": "unsupported_service", "endpoint": "/credential/request", "uid": peer.UID, "service": req.Service})
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported credential service"})
		return
	}

	// --- relay to the broker (fail closed) ---
	grant, err := s.credentialBroker().RequestGrant(r.Context(), peer.UID, req)
	if err != nil {
		// NEVER include secret material in the audit/response.
		failureClass := "broker_denied"
		status := http.StatusForbidden
		if errors.Is(err, ErrCredentialBrokerUnconfigured) {
			failureClass = "broker_unconfigured"
			status = http.StatusServiceUnavailable
		}
		s.audit.Emit("credential-refused", map[string]any{"failure_class": failureClass, "endpoint": "/credential/request", "uid": peer.UID, "service": req.Service, "scope": req.Scope})
		writeJSON(w, status, map[string]any{"error": "credential request denied"})
		return
	}
	if grant.Service == "" {
		grant.Service = req.Service
	}

	// Metadata-only audit — never the grant bytes.
	s.audit.Emit("credential-granted", map[string]any{
		"uid":        peer.UID,
		"service":    grant.Service,
		"scope":      grant.Scope,
		"has_data":   len(grant.Data) > 0,
		"request_id": grant.RequestID,
		"has_exp":    !grant.ExpiresAt.IsZero(),
	})
	writeJSON(w, http.StatusOK, grant)
}
