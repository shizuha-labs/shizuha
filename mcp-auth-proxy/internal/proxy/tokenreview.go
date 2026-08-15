package proxy

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

type IdentityTuple struct {
	UID         uint32 `json:"uid"`
	SANamespace string `json:"sa_namespace"`
	SAName      string `json:"sa_name"`
	PodName     string `json:"pod_name"`
}

type TokenReviewResult struct {
	Authenticated bool
	SANamespace   string
	SAName        string
	PodName       string
	Username      string
}

type TokenReviewer interface {
	Review(ctx context.Context, token, audience string) (TokenReviewResult, error)
}

type FailClosedTokenReviewer struct{ Reason string }

func (f FailClosedTokenReviewer) Review(context.Context, string, string) (TokenReviewResult, error) {
	return TokenReviewResult{}, errors.New(f.Reason)
}

type StubTokenReviewer struct{ Allow bool }

func (s StubTokenReviewer) Review(context.Context, string, string) (TokenReviewResult, error) {
	if !s.Allow {
		return TokenReviewResult{}, errors.New("stub tokenreview denied")
	}
	return TokenReviewResult{Authenticated: true, SANamespace: "rt-stub", SAName: "agent-runtime", PodName: "agent-stub", Username: "system:serviceaccount:rt-stub:agent-runtime"}, nil
}

type KubernetesTokenReviewer struct {
	APIServer       string
	BearerTokenPath string
	CACertPath      string
	Client          *http.Client
}

func NewTokenReviewer(cfg Config) TokenReviewer {
	if cfg.TokenReviewMode == "stub" {
		if !cfg.StubTokenReviewAllow {
			return FailClosedTokenReviewer{Reason: "stub tokenreview requested without MCP_AUTH_PROXY_STUB_TOKENREVIEW_ALLOW=true"}
		}
		return StubTokenReviewer{Allow: true}
	}
	if cfg.KubeAPIServer == "" {
		return FailClosedTokenReviewer{Reason: "kubernetes apiserver not configured; refusing bootstrap without TokenReview"}
	}
	return &KubernetesTokenReviewer{APIServer: cfg.KubeAPIServer, BearerTokenPath: cfg.KubeBearerTokenPath, CACertPath: cfg.KubeCACertPath, Client: kubeHTTPClient(cfg.KubeCACertPath)}
}

func kubeHTTPClient(caPath string) *http.Client {
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	if b, err := os.ReadFile(caPath); err == nil {
		pool.AppendCertsFromPEM(b)
	}
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}
}

func (k *KubernetesTokenReviewer) Review(ctx context.Context, token, audience string) (TokenReviewResult, error) {
	if token == "" {
		return TokenReviewResult{}, errors.New("empty projected service account token")
	}
	bearer, err := os.ReadFile(k.BearerTokenPath)
	if err != nil {
		return TokenReviewResult{}, fmt.Errorf("read sidecar serviceaccount token: %w", err)
	}
	body := map[string]any{"apiVersion": "authentication.k8s.io/v1", "kind": "TokenReview", "spec": map[string]any{"token": token, "audiences": []string{audience}}}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k.APIServer+"/apis/authentication.k8s.io/v1/tokenreviews", bytes.NewReader(payload))
	if err != nil {
		return TokenReviewResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+string(bytes.TrimSpace(bearer)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := k.Client.Do(req)
	if err != nil {
		return TokenReviewResult{}, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return TokenReviewResult{}, fmt.Errorf("tokenreview status %d: %s", resp.StatusCode, string(respBody))
	}
	var tr struct {
		Status struct {
			Authenticated bool `json:"authenticated"`
			User          struct {
				Username string              `json:"username"`
				Extra    map[string][]string `json:"extra"`
			} `json:"user"`
			Error string `json:"error"`
		} `json:"status"`
	}
	if err := json.Unmarshal(respBody, &tr); err != nil {
		return TokenReviewResult{}, err
	}
	if !tr.Status.Authenticated {
		if tr.Status.Error != "" {
			return TokenReviewResult{}, errors.New(tr.Status.Error)
		}
		return TokenReviewResult{}, errors.New("tokenreview unauthenticated")
	}
	ns, name := parseSAUsername(tr.Status.User.Username)
	podName := firstExtra(tr.Status.User.Extra, "authentication.kubernetes.io/pod-name")
	return TokenReviewResult{Authenticated: true, SANamespace: ns, SAName: name, PodName: podName, Username: tr.Status.User.Username}, nil
}

func parseSAUsername(u string) (string, string) {
	const prefix = "system:serviceaccount:"
	if len(u) <= len(prefix) || u[:len(prefix)] != prefix {
		return "", ""
	}
	rest := u[len(prefix):]
	for i := 0; i < len(rest); i++ {
		if rest[i] == ':' {
			return rest[:i], rest[i+1:]
		}
	}
	return "", ""
}

func firstExtra(extra map[string][]string, key string) string {
	if v := extra[key]; len(v) > 0 {
		return v[0]
	}
	return ""
}
