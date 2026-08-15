package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Server struct {
	cfg          Config
	audit        *AuditEmitter
	reviewer     TokenReviewer
	mint         MintClient
	upstreams    *UpstreamManager
	mu           sync.RWMutex
	session      *MintResponse
	identity     *IdentityTuple
	agentSession *AgentSession    // PLAT-149: password-minted JWT handed to the agent via GET /token
	credBroker   CredentialBroker // PLAT-166: platform relay for /credential/request (nil = fail-closed)
	lastMintErr  string           // SCLI-154: last mint failure reason, surfaced in /token 503 response
}

// SetAgentSession stores the latest password-minted session (called by the
// background PasswordMinter). Crown-jewel: the token is held in memory only,
// never logged.
func (s *Server) SetAgentSession(sess AgentSession) {
	s.mu.Lock()
	s.agentSession = &sess
	s.mu.Unlock()
}

// SetLastMintError records the most recent mint failure reason so /token 503
// responses can explain WHY the session isn't ready yet (SCLI-154).
func (s *Server) SetLastMintError(errMsg string) {
	s.mu.Lock()
	s.lastMintErr = errMsg
	s.mu.Unlock()
}

// SetBootstrapSession stores the latest SA-token bootstrapped session (called
// by /bootstrap and by the PLAT-1173 background BootstrapRetrier). Crown-jewel:
// the minted session token is held in memory only, never logged.
func (s *Server) SetBootstrapSession(sess MintResponse, identity IdentityTuple) {
	s.mu.Lock()
	s.session = &sess
	s.identity = &identity
	s.mu.Unlock()
}

func NewServer(cfg Config, audit *AuditEmitter, reviewer TokenReviewer, mint MintClient) *Server {
	return &Server{cfg: cfg, audit: audit, reviewer: reviewer, mint: mint, upstreams: NewUpstreamManager(cfg.Upstreams, cfg.ReconnectMaxAttempts, cfg.ReconnectBaseBackoff, audit)}
}

func (s *Server) Serve(ctx context.Context) error {
	// The UDS lives in a pod-shared volume. The agent container runs as a
	// different UID than this nonroot sidecar, so the directory must be
	// traversable and the socket connect-open for the agent to reach it at all.
	// These mode bits are NOT the security boundary: identity is enforced by the
	// SO_PEERCRED peer-UID check in handleBootstrap, which rejects any connecting
	// peer whose UID != ExpectedAgentUID before doing any work — followed by the
	// TokenReview + mint ladder. The socket is pod-local (no host exposure), so
	// 0o711 dir / 0o666 socket only gate in-pod reachability; the peer-cred gate
	// stays authoritative. A 0o750 dir / 0o660 socket (sidecar-owned) would block
	// the agent UID from connecting, failing every /bootstrap before SO_PEERCRED.
	sockDir := filepath.Dir(s.cfg.SocketPath)
	// Collect the directory components that don't exist yet, so we chmod ONLY the
	// dirs we create — never a pre-existing mount point or system dir we may not
	// own (and could not chmod as nonroot anyway).
	var created []string
	for p := sockDir; ; {
		if _, err := os.Stat(p); err == nil {
			break
		}
		created = append(created, p)
		if parent := filepath.Dir(p); parent != p {
			p = parent
		} else {
			break
		}
	}
	if err := os.MkdirAll(sockDir, 0o711); err != nil {
		return err
	}
	// Chmod every directory we just created so the agent UID can traverse the
	// FULL path. MkdirAll applies the process umask, so a restrictive umask
	// (e.g. 0o077) would otherwise leave an intermediate parent like
	// /run/shizuha at 0o700 — non-traversable — and /bootstrap would fail before
	// SO_PEERCRED even though the leaf was fixed. We OWN dirs we just created, so
	// a chmod failure there is a real error.
	for _, p := range created {
		if err := os.Chmod(p, 0o711); err != nil {
			return err
		}
	}
	// Also nudge the leaf socket dir: in Kubernetes it is normally a pre-existing
	// pod-shared volume mount. CRITICAL: when that mount carries a pod fsGroup it
	// is owned by root:fsGroup and the sidecar runs distroless nonroot (e.g. uid
	// 65532), so chmod() EPERMs — you cannot chmod a dir you do not own. That is
	// fine: fsGroup already grants the agent's GID group access (emptyDir is
	// commonly mode 2775, world-traversable). So this is BEST-EFFORT for a
	// pre-existing leaf we did not create — hard-failing here would crash the
	// whole broker on a dir it cannot (and need not) chmod. The socket chmod
	// (0o666) below + SO_PEERCRED remain the authoritative reachability/identity
	// controls. (If we DID create the leaf, the loop above already chmod'd it.)
	if len(created) == 0 || created[0] != sockDir {
		if err := os.Chmod(sockDir, 0o711); err != nil {
			s.audit.Emit("sockdir-chmod-skipped", map[string]any{
				"dir": sockDir, "failure_class": "not_owner", "error": err.Error(),
			})
		}
	}
	_ = os.Remove(s.cfg.SocketPath)
	ln, err := net.Listen("unix", s.cfg.SocketPath)
	if err != nil {
		return err
	}
	defer ln.Close()
	// Connect-open so the agent UID can dial; fail loudly rather than serve an
	// unreachable socket. SO_PEERCRED (handleBootstrap) is the real gate.
	if err := os.Chmod(s.cfg.SocketPath, 0o666); err != nil {
		return err
	}
	httpServer := &http.Server{Handler: s.routes(), ConnContext: ConnContext}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	s.audit.Emit("proxy-started", map[string]any{"socket": s.cfg.SocketPath, "tcp_listener": false})
	err = httpServer.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	mux.HandleFunc("/bootstrap", s.handleBootstrap)
	mux.HandleFunc("/token", s.handleToken)
	mux.HandleFunc("/model-token", s.handleModelToken)
	mux.HandleFunc("/model-token/report-status", s.handleModelTokenReportStatus)
	mux.HandleFunc("/credential/request", s.handleCredentialRequest)
	mux.HandleFunc("/upstreams/health", s.handleUpstreamHealth)
	return mux
}

// handleToken hands the current password-minted JWT to the agent over the
// pod-local UDS. Gated by SO_PEERCRED (same peer-UID check as /bootstrap): only
// the expected agent UID may read the token. The agent never sees AGENT_PASSWORD
// — only the short-lived minted access token. 503 until the first mint lands
// (the agent's readiness probe should gate on /readyz, which reflects this).
func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	peer, ok := PeerCredFromContext(r.Context())
	if !ok {
		s.audit.Emit("identity-mismatch", map[string]any{"failure_class": "tier1_peercred_fail", "endpoint": "/token", "error": "SO_PEERCRED unavailable"})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer credentials unavailable"})
		return
	}
	// FAIL CLOSED (P1): /token has no TokenReview/secret fallback like /bootstrap,
	// and the UDS is chmod 0666 so any in-pod peer can connect. If the expected
	// agent UID isn't configured we CANNOT identify the caller — refuse to serve
	// rather than hand the crown-jewel JWT to any local process.
	if s.cfg.ExpectedAgentUID == nil {
		s.audit.Emit("token-refused", map[string]any{"failure_class": "expected_uid_unconfigured", "endpoint": "/token", "uid": peer.UID})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "token endpoint disabled: expected agent uid not configured"})
		return
	}
	if peer.UID != *s.cfg.ExpectedAgentUID {
		s.audit.Emit("identity-mismatch", map[string]any{"failure_class": "tier1_peercred_fail", "endpoint": "/token", "uid": peer.UID, "expected_uid": *s.cfg.ExpectedAgentUID})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer uid mismatch"})
		return
	}
	s.mu.RLock()
	sess := s.agentSession
	lastErr := s.lastMintErr
	s.mu.RUnlock()
	if sess == nil {
		body := map[string]any{"error": "no session yet"}
		if lastErr != "" {
			body["mint_error"] = lastErr
		}
		writeJSON(w, http.StatusServiceUnavailable, body)
		return
	}
	// Never hand back an expired JWT (P2): during a sustained shizuha-id outage
	// the held session can age past exp before a fresh login succeeds.
	if !sess.Exp.IsZero() && time.Now().After(sess.Exp) {
		s.audit.Emit("token-refused", map[string]any{"failure_class": "session_expired", "endpoint": "/token", "uid": peer.UID})
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "held session expired"})
		return
	}
	resp := map[string]any{"access": sess.Access}
	if !sess.Exp.IsZero() {
		resp["expires_at"] = sess.Exp.UTC().Format(time.RFC3339)
	}
	// Audit the hand-off with metadata only — never the token bytes.
	s.audit.Emit("token-served", map[string]any{"uid": peer.UID, "has_exp": !sess.Exp.IsZero()})
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	bootstrapped := s.session != nil
	// A held-but-expired JWT is NOT ready (P2): otherwise the pod stays Ready and
	// /token would be asked to serve a stale token through a shizuha-id outage.
	hasToken := s.agentSession != nil && (s.agentSession.Exp.IsZero() || time.Now().Before(s.agentSession.Exp))
	s.mu.RUnlock()
	// Ready once the sidecar can serve the agent an identity: either a VALID
	// (unexpired) password-minted JWT is held (PLAT-149 broker path, R5 readiness
	// gate so the agent container waits on sidecar health) or the SA-token
	// bootstrap has minted a session.
	ready := hasToken || bootstrapped
	status := http.StatusOK
	if !ready {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"ready": ready, "bootstrapped": bootstrapped, "has_token": hasToken, "upstreams": s.upstreams.Health()})
}

type bootstrapRequest struct {
	SAToken        string `json:"sa_token"`
	ClaimedAgentID string `json:"claimed_agent_id,omitempty"`
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	peer, ok := PeerCredFromContext(r.Context())
	if !ok {
		s.audit.Emit("identity-mismatch", map[string]any{"failure_class": "tier1_peercred_fail", "error": "SO_PEERCRED unavailable"})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer credentials unavailable"})
		return
	}
	if s.cfg.ExpectedAgentUID != nil && peer.UID != *s.cfg.ExpectedAgentUID {
		s.audit.Emit("identity-mismatch", map[string]any{"failure_class": "tier1_peercred_fail", "uid": peer.UID, "expected_uid": *s.cfg.ExpectedAgentUID})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "peer uid mismatch"})
		return
	}
	var req bootstrapRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	tr, err := s.reviewer.Review(r.Context(), req.SAToken, s.cfg.TokenAudience)
	if err != nil || !tr.Authenticated {
		s.audit.Emit("identity-mismatch", map[string]any{"failure_class": "tier2_tokenreview_fail", "uid": peer.UID, "error": errorString(err)})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tokenreview rejected"})
		return
	}
	identity := IdentityTuple{UID: peer.UID, SANamespace: tr.SANamespace, SAName: tr.SAName, PodName: tr.PodName}
	if identity.SANamespace == "" || identity.SAName == "" || identity.PodName == "" {
		s.audit.Emit("identity-mismatch", map[string]any{"failure_class": "tier2_tokenreview_fail", "uid": peer.UID, "sa_namespace": identity.SANamespace, "sa_name": identity.SAName, "pod_name": identity.PodName, "error": "tokenreview missing pod-bound identity tuple"})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tokenreview missing pod-bound identity tuple"})
		return
	}
	minted, err := s.mint.Mint(r.Context(), MintRequest{SAToken: req.SAToken, ClaimedAgentID: req.ClaimedAgentID, Identity: identity})
	if err != nil {
		s.audit.Emit("mint-rejected", map[string]any{"failure_class": "tier3_mint_rejected", "claimed_agent_id": req.ClaimedAgentID, "uid": identity.UID, "sa_namespace": identity.SANamespace, "sa_name": identity.SAName, "pod_name": identity.PodName, "error": err.Error()})
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "mint rejected"})
		return
	}
	s.SetBootstrapSession(minted, identity)
	s.audit.Emit("bootstrap-succeeded", map[string]any{"agent_id": minted.AgentID, "uid": identity.UID, "sa_namespace": identity.SANamespace, "sa_name": identity.SAName, "pod_name": identity.PodName, "expires_in": minted.ExpiresIn})
	writeJSON(w, http.StatusOK, map[string]any{"agent_id": minted.AgentID, "expires_in": minted.ExpiresIn})
}

// UpstreamAttributionSummary returns the proxy-layer upstream attribution for
// use in refresh-grant audit events (ADR-PLAT-002 §5-INV-2a / PLAT-1065).
func (s *Server) UpstreamAttributionSummary() map[string]any {
	return s.upstreams.AttributionSummary()
}

func (s *Server) handleUpstreamHealth(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("check") == "true" {
		for _, name := range s.cfg.Upstreams {
			s.upstreams.CheckOnce(r.Context(), name)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"upstreams": s.upstreams.Health()})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
