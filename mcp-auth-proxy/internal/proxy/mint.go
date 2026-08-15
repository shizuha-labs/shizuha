package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

type MintRequest struct {
	SAToken        string        `json:"sa_token"`
	ClaimedAgentID string        `json:"claimed_agent_id,omitempty"`
	Identity       IdentityTuple `json:"identity"`
}

type MintResponse struct {
	AgentID      string `json:"agent_id"`
	SessionToken string `json:"session_token"`
	ExpiresIn    int    `json:"expires_in"`
}

type MintClient interface {
	Mint(ctx context.Context, req MintRequest) (MintResponse, error)
}

type FailClosedMintClient struct{ Reason string }

func (f FailClosedMintClient) Mint(context.Context, MintRequest) (MintResponse, error) {
	return MintResponse{}, errors.New(f.Reason)
}

type StubMintClient struct{ Allow bool }

func (s StubMintClient) Mint(_ context.Context, req MintRequest) (MintResponse, error) {
	if !s.Allow {
		return MintResponse{}, errors.New("stub mint denied")
	}
	agent := req.ClaimedAgentID
	if agent == "" {
		agent = "agent-stub"
	}
	return MintResponse{AgentID: agent, SessionToken: "stub-session-token", ExpiresIn: 300}, nil
}

type HTTPMintClient struct {
	URL    string
	Client *http.Client
}

func NewMintClient(cfg Config) MintClient {
	if cfg.MintMode == "stub" {
		if !cfg.StubMintAllow {
			return FailClosedMintClient{Reason: "stub mint requested without MCP_AUTH_PROXY_STUB_MINT_ALLOW=true"}
		}
		return StubMintClient{Allow: true}
	}
	if cfg.MintURL == "" {
		return FailClosedMintClient{Reason: "shizuha-id mint URL not configured; refusing bootstrap without mint seam"}
	}
	return &HTTPMintClient{URL: cfg.MintURL, Client: &http.Client{Timeout: 5 * time.Second}}
}

func (h *HTTPMintClient) Mint(ctx context.Context, req MintRequest) (MintResponse, error) {
	payload, _ := json.Marshal(req)
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(payload))
	if err != nil {
		return MintResponse{}, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	resp, err := h.Client.Do(hreq)
	if err != nil {
		return MintResponse{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return MintResponse{}, fmt.Errorf("mint status %d: %s", resp.StatusCode, string(body))
	}
	var out MintResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return MintResponse{}, err
	}
	if out.AgentID == "" || out.SessionToken == "" {
		return MintResponse{}, errors.New("mint response missing agent_id/session_token")
	}
	return out, nil
}
