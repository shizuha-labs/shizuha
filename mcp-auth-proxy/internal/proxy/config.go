package proxy

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	SocketPath           string
	ExpectedAgentUID     *uint32
	TokenAudience        string
	KubeAPIServer        string
	KubeBearerTokenPath  string
	KubeCACertPath       string
	TokenReviewMode      string
	StubTokenReviewAllow bool
	MintURL              string
	MintMode             string
	StubMintAllow        bool
	Upstreams            []string
	ReconnectMaxAttempts int
	ReconnectBaseBackoff time.Duration
	// PLAT-149 password-mint (broker) path. AgentPassword lives ONLY in the
	// sidecar's env (AGENT_PASSWORD from the per-agent identity Secret); the
	// agent container never receives it.
	AgentUsername string
	AgentPassword string
	IDLoginURL    string
	IDRefreshURL  string
	// HIVE-146: coordinator model-token path. When set, the broker fetches the
	// provider model token from the coordinator and serves it at GET /model-token.
	// CoordinatorBearerToken must carry aud=hive-coordinator + scope=coordinator:model-token.
	CoordinatorURL         string
	CoordinatorBearerToken string
	// PLAT-1173: legacy SA-token bootstrap self-recovery. Enabled by default so
	// a one-shot /bootstrap TokenReview/mint failure does not leave the sidecar
	// permanently unbootstrapped.
	BootstrapRetryEnabled bool
	BootstrapRetryBase    time.Duration
	BootstrapRetryMax     time.Duration
}

// PasswordMintEnabled reports whether the broker should run the AGENT_PASSWORD
// -> JWT mint lifecycle (all of username/password/login URL present).
func (c Config) PasswordMintEnabled() bool {
	return c.AgentUsername != "" && c.AgentPassword != "" && c.IDLoginURL != ""
}

func LoadConfig() (Config, error) {
	cfg := Config{
		SocketPath:             getenv("MCP_AUTH_PROXY_SOCKET", "/run/shizuha/mcp-auth-proxy/proxy.sock"),
		TokenAudience:          getenv("MCP_AUTH_PROXY_TOKEN_AUDIENCE", "shizuha-mcp-auth-proxy"),
		KubeAPIServer:          kubeAPIServer(),
		KubeBearerTokenPath:    getenv("MCP_AUTH_PROXY_KUBE_BEARER_TOKEN", "/var/run/secrets/kubernetes.io/serviceaccount/token"),
		KubeCACertPath:         getenv("MCP_AUTH_PROXY_KUBE_CA_CERT", "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
		TokenReviewMode:        os.Getenv("MCP_AUTH_PROXY_TOKENREVIEW_MODE"),
		StubTokenReviewAllow:   getenvBool("MCP_AUTH_PROXY_STUB_TOKENREVIEW_ALLOW"),
		MintURL:                os.Getenv("MCP_AUTH_PROXY_MINT_URL"),
		MintMode:               os.Getenv("MCP_AUTH_PROXY_MINT_MODE"),
		StubMintAllow:          getenvBool("MCP_AUTH_PROXY_STUB_MINT_ALLOW"),
		AgentUsername:          getenv("AGENT_USERNAME", os.Getenv("MCP_AUTH_PROXY_AGENT_USERNAME")),
		AgentPassword:          os.Getenv("AGENT_PASSWORD"),
		IDLoginURL:             idAuthURL("MCP_AUTH_PROXY_ID_LOGIN_URL", "/id/api/auth/login/"),
		IDRefreshURL:           idAuthURL("MCP_AUTH_PROXY_ID_REFRESH_URL", "/id/api/auth/refresh/"),
		CoordinatorURL:         os.Getenv("MCP_AUTH_PROXY_COORDINATOR_URL"),
		CoordinatorBearerToken: os.Getenv("MCP_AUTH_PROXY_COORDINATOR_TOKEN"),
		BootstrapRetryEnabled:  getenvBoolDefault("MCP_AUTH_PROXY_BOOTSTRAP_RETRY", true),
		BootstrapRetryBase:     time.Duration(getenvInt("MCP_AUTH_PROXY_BOOTSTRAP_RETRY_BASE_MS", 2000)) * time.Millisecond,
		BootstrapRetryMax:      time.Duration(getenvInt("MCP_AUTH_PROXY_BOOTSTRAP_RETRY_MAX_MS", 120000)) * time.Millisecond,
		Upstreams:              splitCSV(os.Getenv("MCP_AUTH_PROXY_UPSTREAMS")),
		ReconnectMaxAttempts:   getenvInt("MCP_AUTH_PROXY_RECONNECT_MAX_ATTEMPTS", 3),
		ReconnectBaseBackoff:   time.Duration(getenvInt("MCP_AUTH_PROXY_RECONNECT_BASE_MS", 250)) * time.Millisecond,
	}
	// A present-but-unparseable expected-UID must fail closed: the operator
	// explicitly tried to enable the tier-1 peer-UID check, so silently leaving
	// ExpectedAgentUID nil (check disabled) is a fail-open on misconfig and
	// contradicts ADR-PLAT-002's fail-closed posture. Unset remains a valid
	// "check disabled".
	if raw := os.Getenv("MCP_AUTH_PROXY_EXPECTED_AGENT_UID"); raw != "" {
		n, err := strconv.ParseUint(raw, 10, 32)
		if err != nil {
			return Config{}, fmt.Errorf("MCP_AUTH_PROXY_EXPECTED_AGENT_UID=%q is not a valid uint32 UID: %w", raw, err)
		}
		v := uint32(n)
		cfg.ExpectedAgentUID = &v
	}
	return cfg, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvBool(k string) bool {
	v := strings.ToLower(os.Getenv(k))
	return v == "1" || v == "true" || v == "yes"
}

func getenvBoolDefault(k string, def bool) bool {
	v := strings.ToLower(os.Getenv(k))
	if v == "" {
		return def
	}
	return v == "1" || v == "true" || v == "yes"
}

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func splitCSV(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func kubeAPIServer() string {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := getenv("KUBERNETES_SERVICE_PORT", "443")
	if host == "" {
		return ""
	}
	// net.JoinHostPort bracket-wraps IPv6 literals (e.g. fd00::1 → [fd00::1]:443);
	// naive concatenation produces an unparseable authority on IPv6 clusters.
	return "https://" + net.JoinHostPort(host, port)
}

// idAuthURL returns the explicit URL from explicitEnv if set, otherwise derives
// it from MCP_AUTH_PROXY_ID_BASE_URL + path. Empty when neither is configured,
// which leaves password-mint disabled (fail-closed: no half-configured mint).
func idAuthURL(explicitEnv, path string) string {
	if v := os.Getenv(explicitEnv); v != "" {
		return v
	}
	base := strings.TrimRight(os.Getenv("MCP_AUTH_PROXY_ID_BASE_URL"), "/")
	if base == "" {
		return ""
	}
	return base + path
}
