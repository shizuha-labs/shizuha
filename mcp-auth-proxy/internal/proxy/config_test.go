package proxy

import "testing"

// A present-but-unparseable expected-UID must fail closed (ADR-PLAT-002
// fail-closed posture): the operator tried to enable the tier-1 peer-UID check,
// so silently disabling it on misconfig is a fail-open.
func TestLoadConfigInvalidExpectedAgentUIDFailsClosed(t *testing.T) {
	t.Setenv("MCP_AUTH_PROXY_EXPECTED_AGENT_UID", "not-a-number")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("expected LoadConfig to fail closed on unparseable MCP_AUTH_PROXY_EXPECTED_AGENT_UID, got nil error")
	}
}

func TestLoadConfigValidExpectedAgentUID(t *testing.T) {
	t.Setenv("MCP_AUTH_PROXY_EXPECTED_AGENT_UID", "1000")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ExpectedAgentUID == nil || *cfg.ExpectedAgentUID != 1000 {
		t.Fatalf("ExpectedAgentUID = %v; want 1000", cfg.ExpectedAgentUID)
	}
}

// Unset = "check disabled" remains valid (nil UID, no error).
func TestLoadConfigUnsetExpectedAgentUIDDisablesCheck(t *testing.T) {
	t.Setenv("MCP_AUTH_PROXY_EXPECTED_AGENT_UID", "")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ExpectedAgentUID != nil {
		t.Fatalf("ExpectedAgentUID = %v; want nil (check disabled)", *cfg.ExpectedAgentUID)
	}
}

// IPv6 KUBERNETES_SERVICE_HOST must produce a parseable authority via
// net.JoinHostPort (bracket-wrapped), not naive concatenation.
func TestKubeAPIServerIPv6(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "fd00::1")
	t.Setenv("KUBERNETES_SERVICE_PORT", "443")
	if got, want := kubeAPIServer(), "https://[fd00::1]:443"; got != want {
		t.Fatalf("kubeAPIServer() = %q; want %q", got, want)
	}
}

func TestLoadConfigBootstrapRetryDefaultsEnabled(t *testing.T) {
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.BootstrapRetryEnabled {
		t.Fatal("BootstrapRetryEnabled = false; want true by default")
	}
	if cfg.BootstrapRetryBase <= 0 || cfg.BootstrapRetryMax <= 0 {
		t.Fatalf("bootstrap retry backoff not populated: base=%v max=%v", cfg.BootstrapRetryBase, cfg.BootstrapRetryMax)
	}
}

func TestLoadConfigBootstrapRetryCanBeDisabled(t *testing.T) {
	t.Setenv("MCP_AUTH_PROXY_BOOTSTRAP_RETRY", "false")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.BootstrapRetryEnabled {
		t.Fatal("BootstrapRetryEnabled = true; want false from env")
	}
}
