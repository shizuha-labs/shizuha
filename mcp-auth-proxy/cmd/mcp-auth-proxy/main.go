package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/shizuha-labs/shizuha-beta/mcp-auth-proxy/internal/proxy"
)

func main() {
	// `healthcheck` is an exec-over-UDS probe used by the sidecar's
	// readiness/liveness probes (the distroless image has no shell/curl). It
	// dials the pod-local UDS and exits 0/non-0; it never serves.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(proxy.RunHealthCheckCommand(os.Args[2:], os.Stderr))
	}

	cfg, err := proxy.LoadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	audit := proxy.NewAuditEmitter(os.Stderr)
	srv := proxy.NewServer(cfg, audit, proxy.NewTokenReviewer(cfg), proxy.NewMintClient(cfg))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// PLAT-149 broker path: if AGENT_PASSWORD (+ username + id login URL) is
	// configured, run the background mint/refresh lifecycle that hands the agent
	// a JWT over GET /token. AGENT_PASSWORD is read here (sidecar only) and never
	// forwarded to the agent container.
	if cfg.PasswordMintEnabled() {
		// FAIL CLOSED (P1): the /token hand-off has no fallback auth, so without a
		// configured expected agent UID it would serve the minted JWT to any
		// in-pod peer. Refuse to start the broker in that state rather than run
		// the live token-theft hole.
		if cfg.ExpectedAgentUID == nil {
			log.Fatal("password-mint enabled but MCP_AUTH_PROXY_EXPECTED_AGENT_UID is unset — refusing to start: /token would have no peer-UID gate (fail closed)")
		}
		client := proxy.NewPasswordMintClient(cfg.IDLoginURL, cfg.IDRefreshURL, cfg.AgentUsername, cfg.AgentPassword)
		minter := proxy.NewPasswordMinter(client, srv, audit, proxy.DefaultMinterConfig(), time.Now().UnixNano())
		// ADR-PLAT-002 §5-INV-2a (PLAT-1065): proxy layer supplies upstream attribution
		// on refresh-grant events; id-core never carries upstream_id.
		minter.SetUpstreamAttributionFn(srv.UpstreamAttributionSummary)
		go minter.Run(ctx)
	}
	if cfg.BootstrapRetryEnabled && cfg.MintURL != "" {
		b := proxy.DefaultBootstrapRetryConfig()
		b.SATokenPath = cfg.KubeBearerTokenPath
		b.TokenAudience = cfg.TokenAudience
		b.ClaimedAgentID = cfg.AgentUsername
		b.ExpectedAgentUID = cfg.ExpectedAgentUID
		b.BackoffBase = cfg.BootstrapRetryBase
		b.BackoffMax = cfg.BootstrapRetryMax
		go proxy.NewBootstrapRetrier(proxy.NewTokenReviewer(cfg), proxy.NewMintClient(cfg), srv, audit, b, time.Now().UnixNano()).Run(ctx)
	}
	if err := srv.Serve(ctx); err != nil {
		log.Fatal(err)
	}
}
