package proxy

// Coordinator credentials belong only to the broker. ID issues short-lived,
// revocable client-credentials tokens; callers never receive this bearer.
import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
)

func (c Config) coordinatorOAuthEnabled() bool {
	return c.CoordinatorOAuthTokenURL != "" || c.CoordinatorOAuthClientID != "" || c.CoordinatorOAuthClientSecret != "" || c.CoordinatorOAuthScope != ""
}

func (c Config) validateCoordinatorOAuth() error {
	if !c.coordinatorOAuthEnabled() {
		return nil
	}
	if strings.TrimSpace(c.CoordinatorOAuthTokenURL) == "" || c.CoordinatorOAuthClientID != "hive-coordinator-broker" || strings.TrimSpace(c.CoordinatorOAuthClientSecret) == "" || c.CoordinatorOAuthScope != "hive-coordinator:model-token" {
		return fmt.Errorf("coordinator OAuth requires complete client credentials and the coordinator scope")
	}
	u, err := url.Parse(c.CoordinatorOAuthTokenURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("invalid coordinator OAuth token endpoint")
	}
	return nil
}

func (s *Server) coordinatorBearer(ctx context.Context) (string, error) {
	if !s.cfg.coordinatorOAuthEnabled() {
		if strings.TrimSpace(s.cfg.CoordinatorBearerToken) == "" {
			return "", fmt.Errorf("coordinator credential unconfigured")
		}
		return s.cfg.CoordinatorBearerToken, nil
	}
	if err := s.cfg.validateCoordinatorOAuth(); err != nil {
		return "", err
	}
	// Serialize refresh, including the first concurrent projection/model calls.
	// HTTP is bounded and context-cancelled; failures never retain an expired
	// bearer or fall back to a legacy token configured alongside OAuth.
	s.coordinatorOAuthMu.Lock()
	defer s.coordinatorOAuthMu.Unlock()
	now := time.Now
	if s.coordinatorOAuthNow != nil {
		now = s.coordinatorOAuthNow
	}
	if s.coordinatorOAuthToken != "" && now().Before(s.coordinatorOAuthRefreshAt) {
		return s.coordinatorOAuthToken, nil
	}
	s.coordinatorOAuthToken = ""
	s.coordinatorOAuthRefreshAt = time.Time{}
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("coordinator OAuth request cancelled")
	}
	started := now()
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {s.cfg.CoordinatorOAuthClientID}, "client_secret": {s.cfg.CoordinatorOAuthClientSecret}, "scope": {s.cfg.CoordinatorOAuthScope}}
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, s.cfg.CoordinatorOAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("coordinator OAuth request invalid")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("coordinator OAuth transport unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("coordinator OAuth HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 {
		return "", fmt.Errorf("coordinator OAuth response size invalid")
	}
	var result struct {
		AccessToken  string `json:"access_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
		Scope        string `json:"scope"`
		RefreshToken string `json:"refresh_token"`
	}
	if json.Unmarshal(raw, &result) != nil || result.AccessToken == "" || strings.IndexFunc(result.AccessToken, unicode.IsSpace) >= 0 || !strings.EqualFold(result.TokenType, "Bearer") || result.ExpiresIn <= 0 || result.ExpiresIn > 900 || result.Scope != s.cfg.CoordinatorOAuthScope || result.RefreshToken != "" {
		return "", fmt.Errorf("coordinator OAuth response invalid")
	}
	ttl := time.Duration(result.ExpiresIn) * time.Second
	skew := 30 * time.Second
	if ttl/10 < skew {
		skew = ttl / 10
	}
	refreshAt := started.Add(ttl - skew)
	if !now().Before(refreshAt) {
		return "", fmt.Errorf("coordinator OAuth response already expired")
	}
	s.coordinatorOAuthToken = result.AccessToken
	s.coordinatorOAuthRefreshAt = refreshAt
	return result.AccessToken, nil
}
