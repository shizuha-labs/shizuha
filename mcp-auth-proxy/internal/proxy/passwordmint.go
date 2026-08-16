package proxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// AgentSession is a minted shizuha-id session for the fleet agent (PLAT-149,
// HLD PLAT-147 §5 Q2). Access is the JWT handed to the agent over the pod-local
// UDS; Refresh renews it. Both are crown-jewel material — never logged/echoed.
type AgentSession struct {
	Access  string
	Refresh string
	// Exp is parsed from the Access JWT's exp claim, used only to schedule
	// refresh. Zero if the token carries no parseable exp (caller falls back to
	// a default refresh interval).
	Exp time.Time
}

// PasswordMintClient mints/refreshes a shizuha-id JWT from AGENT_USERNAME +
// AGENT_PASSWORD against the standard shizuha-id auth endpoints — the same path
// a human (and today's daemon) uses: POST /id/api/auth/login/ {username,password}
// -> {access,refresh}, and POST /id/api/auth/refresh/ {refresh} -> {access,refresh}.
//
// AGENT_PASSWORD lives ONLY inside this sidecar (never the agent container).
// The password and token bytes are never placed in error strings or audit
// events (HLD §5 crown-jewel / HIVE-2 M5 no-log discipline).
type PasswordMintClient struct {
	LoginURL   string
	RefreshURL string
	Username   string
	password   string
	HTTP       *http.Client
}

// NewPasswordMintClient builds a client. password is held unexported so it is
// not reachable via reflection-based struct dumping in logs.
func NewPasswordMintClient(loginURL, refreshURL, username, password string) *PasswordMintClient {
	return &PasswordMintClient{
		LoginURL:   loginURL,
		RefreshURL: refreshURL,
		Username:   username,
		password:   password,
		HTTP:       &http.Client{Timeout: 10 * time.Second},
	}
}

// authTokens accepts BOTH shizuha-id response shapes: top-level
// {access, refresh} (mini-connect) and nested {tokens: {access, refresh}, user}
// (the shape src/daemon/agent-accounts.ts consumes from /id/api/auth/login/).
type authTokens struct {
	Access  string `json:"access"`
	Refresh string `json:"refresh"`
	Tokens  *struct {
		Access  string `json:"access"`
		Refresh string `json:"refresh"`
	} `json:"tokens"`
}

// Login performs the username/password mint.
func (c *PasswordMintClient) Login(ctx context.Context) (AgentSession, error) {
	body, _ := json.Marshal(map[string]string{"username": c.Username, "password": c.password})
	return c.post(ctx, c.LoginURL, body)
}

// Refresh exchanges a refresh token for a fresh access (+ possibly refresh) token.
// Falls back to nothing here — the caller re-Logins if refresh fails.
func (c *PasswordMintClient) Refresh(ctx context.Context, refresh string) (AgentSession, error) {
	if refresh == "" {
		return AgentSession{}, errors.New("refresh token empty")
	}
	body, _ := json.Marshal(map[string]string{"refresh": refresh})
	return c.post(ctx, c.RefreshURL, body)
}

func (c *PasswordMintClient) post(ctx context.Context, url string, body []byte) (AgentSession, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return AgentSession{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		// %w on a *url.Error includes the URL/method but never the request body
		// (the password). That is acceptable; the password is not in the error.
		return AgentSession{}, fmt.Errorf("shizuha-id auth request failed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		// Surface status only — never echo the response body verbatim (it could
		// reflect submitted input or leak token material).
		return AgentSession{}, fmt.Errorf("shizuha-id auth rejected: status %d", resp.StatusCode)
	}
	var t authTokens
	if err := json.Unmarshal(raw, &t); err != nil {
		return AgentSession{}, errors.New("shizuha-id auth: malformed response")
	}
	access, refresh := t.Access, t.Refresh
	if access == "" && t.Tokens != nil {
		// Fall back to the nested {tokens:{...}} shape before declaring failure.
		access, refresh = t.Tokens.Access, t.Tokens.Refresh
	}
	if access == "" {
		return AgentSession{}, errors.New("shizuha-id auth: response missing access token")
	}
	sess := AgentSession{Access: access, Refresh: refresh}
	if exp, err := jwtExp(access); err == nil {
		sess.Exp = exp
	}
	return sess, nil
}

// jwtExp extracts the exp claim from a JWT WITHOUT verifying the signature. The
// sidecar trusts shizuha-id as issuer (the token is forwarded to the agent, not
// authorized here); exp is needed only to schedule refresh. Returns an error if
// the token is not a well-formed JWT or carries no numeric exp.
func jwtExp(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, errors.New("not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, err
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, err
	}
	if claims.Exp == 0 {
		return time.Time{}, errors.New("jwt has no exp claim")
	}
	return time.Unix(claims.Exp, 0), nil
}
