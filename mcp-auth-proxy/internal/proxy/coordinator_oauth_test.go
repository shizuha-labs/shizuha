package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func oauthConfig(t *testing.T, tokenURL, projectionURL string) Config {
	t.Helper()
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_OAUTH_TOKEN_URL", tokenURL)
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_OAUTH_CLIENT_ID", "hive-coordinator-broker")
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_OAUTH_CLIENT_SECRET", "test-client-secret")
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_OAUTH_SCOPE", "hive-coordinator:model-token")
	t.Setenv("MCP_AUTH_PROXY_PROJECTION_URL", projectionURL)
	t.Setenv("MCP_AUTH_PROXY_EXPECTED_AGENT_UID", "1000")
	t.Setenv("AGENT_ID", "agent-1")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestCoordinatorOAuthRenewalFailureClearsOldBearerAndRecovers(t *testing.T) {
	var calls atomic.Int32
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		if call == 2 {
			http.Error(w, "secret-upstream-body", 401)
			return
		}
		token := "first"
		if call > 2 {
			token = "renewed"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": token, "token_type": "Bearer", "expires_in": 900, "scope": "hive-coordinator:model-token"})
	}))
	defer issuer.Close()
	cfg := oauthConfig(t, issuer.URL, "http://127.0.0.1/projection")
	cfg.CoordinatorBearerToken = "forbidden-static-fallback"
	s := newTokenServer(cfg)
	now := time.Now()
	s.coordinatorOAuthNow = func() time.Time { return now }
	token, err := s.coordinatorBearer(context.Background())
	if err != nil || token != "first" {
		t.Fatalf("first acquisition failed: %v", err)
	}
	now = now.Add(871 * time.Second)
	token, err = s.coordinatorBearer(context.Background())
	if err == nil || token != "" || s.coordinatorOAuthToken != "" || strings.Contains(err.Error(), "secret") {
		t.Fatal("refresh failure retained/fell back/leaked credential")
	}
	token, err = s.coordinatorBearer(context.Background())
	if err != nil || token != "renewed" {
		t.Fatalf("recovery failed: %v", err)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls=%d", calls.Load())
	}
}

func TestCoordinatorOAuthConcurrentCallsMintOnce(t *testing.T) {
	var calls atomic.Int32
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "shared", "token_type": "Bearer", "expires_in": 900, "scope": "hive-coordinator:model-token"})
	}))
	defer issuer.Close()
	s := newTokenServer(oauthConfig(t, issuer.URL, "http://127.0.0.1/projection"))
	var group sync.WaitGroup
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			token, err := s.coordinatorBearer(context.Background())
			if err != nil || token != "shared" {
				t.Errorf("acquisition failed: %v", err)
			}
		}()
	}
	group.Wait()
	if calls.Load() != 1 {
		t.Fatalf("mints=%d", calls.Load())
	}
}

func TestCoordinatorOAuthRefusesInvalidResponsesAndRedirects(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	for _, body := range []string{`{"access_token":"secret","token_type":"Bearer","expires_in":0}`, `{"access_token":"secret","token_type":"Basic","expires_in":900}`, `{"access_token":"","token_type":"Bearer","expires_in":900}`, `{"access_token":"secret","token_type":"Bearer","expires_in":9000000000000000000}`, `not json`, strings.Repeat("x", (64<<10)+1), "redirect"} {
		t.Run(body[:min(20, len(body))], func(t *testing.T) {
			issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if body == "redirect" {
					http.Redirect(w, r, target.URL, 307)
					return
				}
				_, _ = w.Write([]byte(body))
			}))
			defer issuer.Close()
			cfg := oauthConfig(t, issuer.URL, "http://127.0.0.1/projection")
			cfg.CoordinatorBearerToken = "legacy"
			s := newTokenServer(cfg)
			token, err := s.coordinatorBearer(context.Background())
			if err == nil || token != "" || strings.Contains(err.Error(), "secret") {
				t.Fatal("invalid issuer response accepted or leaked")
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatal("client secret followed redirect")
	}
}

func TestCoordinatorOAuthAllRoutesShareBearerAndPeerGate(t *testing.T) {
	var mints, productions atomic.Int32
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mints.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "shared", "token_type": "Bearer", "expires_in": 900, "scope": "hive-coordinator:model-token"})
	}))
	defer issuer.Close()
	producer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		productions.Add(1)
		if r.Header.Get("Authorization") != "Bearer shared" {
			t.Error("wrong bearer")
		}
		if strings.HasSuffix(r.URL.Path, "model-token") {
			_, _ = w.Write([]byte(`{"token":"provider-token","entry_id":"entry","lease_id":"lease","lease_expires_at":"later"}`))
			return
		}
		_, _ = w.Write([]byte(`{"signature":"opaque"}`))
	}))
	defer producer.Close()
	cfg := oauthConfig(t, issuer.URL, producer.URL+"/projection")
	cfg.CoordinatorURL = producer.URL + "/model-token"
	s := newTokenServer(cfg)
	// A wrong local peer must never cause a privileged mint.
	w := httptest.NewRecorder()
	s.handleMCPProjection(w, projectionRequest(1001, testProjectionNonce))
	if w.Code != 401 || mints.Load() != 0 {
		t.Fatal("peer gate mint")
	}
	for _, path := range []string{"/mcp-projection", "/model-token?provider=xai-grok", "/model-token/report-status"} {
		req := projectionRequest(1000, testProjectionNonce)
		if strings.HasPrefix(path, "/model-token") {
			method, body := "GET", ""
			if strings.Contains(path, "report-status") {
				method = "POST"
				body = `{"entry_id":"entry","lease_id":"lease"}`
			}
			req = httptest.NewRequest(method, path, strings.NewReader(body))
			req = req.WithContext(context.WithValue(req.Context(), peerCredContextKey{}, PeerCred{UID: 1000}))
		}
		w = httptest.NewRecorder()
		s.routes().ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("%s status=%d body=%s", path, w.Code, w.Body.String())
		}
	}
	if mints.Load() != 1 || productions.Load() != 3 {
		t.Fatalf("mints=%d productions=%d", mints.Load(), productions.Load())
	}
}

func TestCoordinatorOAuthActualProjectionAcquiresAndCaches(t *testing.T) {
	var mints, projections atomic.Int32
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mints.Add(1)
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		for key, value := range map[string]string{"grant_type": "client_credentials", "client_id": "hive-coordinator-broker", "client_secret": "test-client-secret", "scope": "hive-coordinator:model-token"} {
			if r.Form.Get(key) != value {
				t.Errorf("incorrect %s", key)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "renewable", "token_type": "Bearer", "expires_in": 900, "scope": "hive-coordinator:model-token"})
	}))
	defer issuer.Close()
	producer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		projections.Add(1)
		if r.Header.Get("Authorization") != "Bearer renewable" {
			t.Error("wrong coordinator authorization")
		}
		_, _ = w.Write([]byte(`{"signature":"opaque"}`))
	}))
	defer producer.Close()
	s := newTokenServer(oauthConfig(t, issuer.URL, producer.URL))
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		s.handleMCPProjection(w, projectionRequest(1000, testProjectionNonce))
		if w.Code != 200 {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
	if mints.Load() != 1 || projections.Load() != 2 {
		t.Fatalf("mints=%d projections=%d", mints.Load(), projections.Load())
	}
}

func TestCoordinatorOAuthPartialConfigurationRefusesStaticFallback(t *testing.T) {
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_OAUTH_TOKEN_URL", "http://127.0.0.1/token")
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_OAUTH_CLIENT_ID", "")
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_OAUTH_CLIENT_SECRET", "")
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_OAUTH_SCOPE", "")
	t.Setenv("MCP_AUTH_PROXY_COORDINATOR_TOKEN", "legacy-static")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("partial OAuth configuration accepted static fallback")
	}
}

func TestCoordinatorOAuthExactGrantEnvelope(t *testing.T) {
	for key, value := range map[string]any{"scope": "wrong:scope", "refresh_token": "forbidden-refresh", "expires_in": 901, "access_token": "contains whitespace"} {
		t.Run(key, func(t *testing.T) {
			issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				envelope := map[string]any{"access_token": "valid-bearer", "token_type": "Bearer", "expires_in": 900, "scope": "hive-coordinator:model-token"}
				envelope[key] = value
				_ = json.NewEncoder(w).Encode(envelope)
			}))
			defer issuer.Close()
			s := newTokenServer(oauthConfig(t, issuer.URL, "http://127.0.0.1/projection"))
			bearer, err := s.coordinatorBearer(context.Background())
			if err == nil || bearer != "" {
				t.Fatal("invalid grant envelope accepted")
			}
		})
	}
	cfg := oauthConfig(t, "http://127.0.0.1/token", "http://127.0.0.1/projection")
	cfg.CoordinatorOAuthClientID = "some-other-client"
	if cfg.validateCoordinatorOAuth() == nil {
		t.Fatal("unregistered broker client identity accepted")
	}
}
