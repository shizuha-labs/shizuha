use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

/// The health response from the local Shizuha agent core (GET /health).
///
/// Per SCLI-133 §3.1: returns version, protocol version, auth status,
/// available providers, and capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHealth {
    /// Core semantic version (e.g. "0.1.0").
    pub version: String,
    /// Protocol version for compatibility checking.
    #[serde(default = "default_protocol_version")]
    pub protocol_version: u64,
    /// Authentication / account state.
    #[serde(default)]
    pub auth_status: AuthStatus,
    /// List of available provider names (e.g. ["cortex", "anthropic"]).
    #[serde(default)]
    pub providers: Vec<String>,
    /// List of available model IDs.
    #[serde(default)]
    pub models: Vec<String>,
    /// Capability flags the core advertises.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Human-readable status message.
    #[serde(default)]
    pub message: String,
}

fn default_protocol_version() -> u64 {
    1
}

/// Authentication / account state reported by the core.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// Whether the user is authenticated / signed in.
    #[serde(default)]
    pub authenticated: bool,
    /// Account email or identifier, if available.
    #[serde(default)]
    pub account: String,
    /// Human-readable status.
    #[serde(default)]
    pub message: String,
}

impl Default for AuthStatus {
    fn default() -> Self {
        Self {
            authenticated: false,
            account: String::new(),
            message: "Not authenticated".to_string(),
        }
    }
}

/// The health check result sent to the Tauri frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult {
    /// Whether the core is reachable and healthy.
    pub reachable: bool,
    /// The core health data, if reachable.
    pub health: Option<CoreHealth>,
    /// Error message if unreachable or incompatible.
    pub error: Option<String>,
    /// Whether the core version is compatible with this app.
    pub compatible: bool,
    /// Whether the core responded with a server error (non-2xx, parse failure).
    /// When true, the core is reachable but unhealthy — distinct from protocol mismatch.
    #[serde(default)]
    pub server_error: bool,
    /// Suggested next action for the user.
    pub next_action: String,
}

/// The protocol version this app expects.
pub const EXPECTED_PROTOCOL_VERSION: u64 = 1;

/// Default URL where the local core is expected to listen.
pub const DEFAULT_CORE_URL: &str = "http://127.0.0.1:8015";

/// Validate that a core URL points to a loopback address.
///
/// Returns `Ok(normalized_url)` if the URL is a valid loopback URL
/// (localhost, 127.0.0.1, [::1]) with http scheme and a port.
/// Returns `Err` with a user-facing message otherwise.
fn validate_core_url(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw).map_err(|_| {
        format!("Invalid URL: '{}'. Expected http://127.0.0.1:<port>", raw)
    })?;

    if parsed.scheme() != "http" {
        return Err(format!(
            "Unsupported scheme '{}'. Only http is allowed for local core connections.",
            parsed.scheme()
        ));
    }

    // Validate using parsed host types, not string prefixes. A hostname like
    // "127.evil.example" starts with "127." but is a DNS name that can resolve
    // to a remote address — that must be rejected.
    let is_loopback = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };

    if !is_loopback {
        return Err(format!(
            "Remote URL '{}' is not allowed. Only loopback addresses (localhost, 127.0.0.1, [::1]) are permitted.",
            raw
        ));
    }

    if parsed.port().is_none() {
        return Err(format!(
            "URL '{}' must include a port number (e.g. http://127.0.0.1:8015).",
            raw
        ));
    }

    Ok(raw.to_string())
}

/// Check the health of the local Shizuha agent core.
///
/// Hits `GET /health` on the local core and returns a structured result.
/// Handles connection errors, timeouts, and protocol version mismatches.
pub async fn check_core_health(core_url: Option<String>) -> HealthResult {
    let base_url = match core_url {
        Some(url) if !url.is_empty() => match validate_core_url(&url) {
            Ok(validated) => validated,
            Err(e) => {
                return HealthResult {
                    reachable: false,
                    health: None,
                    error: Some(e),
                    compatible: false,
                    server_error: false,
                    next_action: "Use the default core URL (http://127.0.0.1:8015) or a valid loopback address.".to_string(),
                };
            }
        },
        _ => DEFAULT_CORE_URL.to_string(),
    };
    let health_url = format!("{}/health", base_url.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return HealthResult {
                reachable: false,
                health: None,
                error: Some(format!("Failed to create HTTP client: {}", e)),
                compatible: false,
                server_error: false,
                next_action: "Check your Shizuha installation and try again.".to_string(),
            };
        }
    };

    let response = client.get(&health_url).send().await;

    let health: CoreHealth = match response {
        Ok(resp) => {
            if !resp.status().is_success() {
                return HealthResult {
                    reachable: true,
                    health: None,
                    error: Some(format!(
                        "Core returned HTTP {}",
                        resp.status().as_u16()
                    )),
                    compatible: false,
                    server_error: true,
                    next_action: "Check the core logs for errors.".to_string(),
                };
            }
            match resp.json::<CoreHealth>().await {
                Ok(h) => h,
                Err(e) => {
                    return HealthResult {
                        reachable: true,
                        health: None,
                        error: Some(format!(
                            "Failed to parse health response: {}",
                            e
                        )),
                        compatible: false,
                        server_error: true,
                        next_action: "The core may be running an incompatible version.".to_string(),
                    };
                }
            }
        }
        Err(e) => {
            let error_msg = e.to_string();
            let (user_message, next_action) = if error_msg.contains("dns") || error_msg.contains("resolve") {
                (
                    format!("Cannot resolve core URL: {}", base_url),
                    "Ensure the Shizuha core is installed and running.".to_string(),
                )
            } else if error_msg.contains("Connection refused") {
                (
                    format!("Core not reachable at {}", base_url),
                    "Start the Shizuha core first: run 'shizuha gateway' or launch the Shizuha daemon.".to_string(),
                )
            } else if error_msg.contains("timed out") {
                (
                    format!("Core at {} timed out", base_url),
                    "The core may be busy or hung. Check the core logs or restart it.".to_string(),
                )
            } else {
                (
                    format!("Cannot connect to core: {}", error_msg),
                    "Check your Shizuha installation and try again.".to_string(),
                )
            };

            return HealthResult {
                reachable: false,
                health: None,
                error: Some(user_message),
                compatible: false,
                server_error: false,
                next_action,
            };
        }
    };

    // Check protocol version compatibility
    let compatible = health.protocol_version == EXPECTED_PROTOCOL_VERSION;
    let (error, next_action) = if !compatible {
        (
            Some(format!(
                "Protocol version mismatch: core v{}, app expects v{}. \
                 Please update your Shizuha installation.",
                health.protocol_version, EXPECTED_PROTOCOL_VERSION
            )),
            "Upgrade required: install the latest Shizuha version.".to_string(),
        )
    } else {
        (None, String::new())
    };

    HealthResult {
        reachable: true,
        health: Some(health),
        error,
        compatible,
        server_error: false,
        next_action,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_auth_status() {
        let status = AuthStatus::default();
        assert!(!status.authenticated);
        assert_eq!(status.message, "Not authenticated");
    }

    #[test]
    fn test_default_protocol_version() {
        assert_eq!(default_protocol_version(), 1);
    }

    #[test]
    fn test_expected_protocol_version() {
        assert_eq!(EXPECTED_PROTOCOL_VERSION, 1);
    }

    // ── URL validation tests ──

    #[test]
    fn test_validate_core_url_loopback_ipv4() {
        assert!(validate_core_url("http://127.0.0.1:8015").is_ok());
    }

    #[test]
    fn test_validate_core_url_localhost() {
        assert!(validate_core_url("http://localhost:8015").is_ok());
    }

    #[test]
    fn test_validate_core_url_loopback_ipv6() {
        assert!(validate_core_url("http://[::1]:8015").is_ok());
    }

    #[test]
    fn test_validate_core_url_rejects_remote() {
        let result = validate_core_url("http://example.com:8015");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not allowed"));
    }

    #[test]
    fn test_validate_core_url_rejects_https() {
        let result = validate_core_url("https://127.0.0.1:8015");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("scheme"));
    }

    #[test]
    fn test_validate_core_url_rejects_missing_port() {
        let result = validate_core_url("http://127.0.0.1");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("port"));
    }

    #[test]
    fn test_validate_core_url_rejects_invalid() {
        let result = validate_core_url("not-a-url");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid URL"));
    }

    #[test]
    fn test_validate_core_url_loopback_ipv4_range() {
        // Numeric 127.0.0.0/8 addresses are loopback and must still be accepted.
        assert!(validate_core_url("http://127.0.0.2:8015").is_ok());
        assert!(validate_core_url("http://127.255.255.254:8015").is_ok());
    }

    #[test]
    fn test_validate_core_url_rejects_127_prefix_dns_names() {
        // Hostnames that merely start with "127." are DNS names, not IPs.
        for raw in [
            "http://127.evil.example:8015",
            "http://127.0.0.1.example.com:8015",
            "http://127.0.0.1.attacker.tld:8015",
        ] {
            let result = validate_core_url(raw);
            assert!(result.is_err(), "expected rejection for {}", raw);
            assert!(
                result.unwrap_err().contains("not allowed"),
                "expected 'not allowed' for {}",
                raw
            );
        }
    }

    // ── Integration tests ──

    #[tokio::test]
    async fn test_check_core_health_connection_refused() {
        // Point to a port where nothing is listening
        let result = check_core_health(Some("http://127.0.0.1:19999".to_string())).await;
        assert!(!result.reachable);
        assert!(result.error.is_some());
        assert!(result.error.as_ref().unwrap().contains("Connection refused")
            || result.error.as_ref().unwrap().contains("Cannot connect"));
        assert!(!result.compatible);
        assert!(!result.next_action.is_empty());
    }

    #[tokio::test]
    async fn test_check_core_health_invalid_url() {
        let result = check_core_health(Some("http://nonexistent.invalid:9999".to_string())).await;
        assert!(!result.reachable);
        assert!(result.error.is_some());
        assert!(!result.compatible);
    }

    #[tokio::test]
    async fn test_check_core_health_rejects_remote_url() {
        let result = check_core_health(Some("http://evil.com:8015".to_string())).await;
        assert!(!result.reachable);
        assert!(result.error.is_some());
        assert!(result.error.as_ref().unwrap().contains("not allowed"));
    }

    #[tokio::test]
    async fn test_check_core_health_successful_handshake() {
        // Start a mock health server
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = tokio::io::BufReader::new(stream);
            let mut request_line = String::new();
            tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut request_line).await.unwrap();

            // Read headers until empty line
            loop {
                let mut header = String::new();
                tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut header).await.unwrap();
                if header.trim().is_empty() {
                    break;
                }
            }

            let body = r#"{
                "version": "0.1.0",
                "protocolVersion": 1,
                "authStatus": { "authenticated": true, "account": "test@shizuha.com", "message": "Authenticated" },
                "providers": ["cortex"],
                "models": ["claude-sonnet-4"],
                "capabilities": ["chat"],
                "message": "OK"
            }"#;

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );

            // Write response
            use tokio::io::AsyncWriteExt;
            let mut writer = tokio::io::BufWriter::new(reader.into_inner());
            writer.write_all(response.as_bytes()).await.unwrap();
            writer.flush().await.unwrap();
        });

        let url = format!("http://127.0.0.1:{}", port);
        let result = check_core_health(Some(url)).await;

        assert!(result.reachable, "Should be reachable: {:?}", result.error);
        assert!(result.compatible, "Should be compatible");
        assert!(result.health.is_some());
        assert_eq!(result.health.as_ref().unwrap().version, "0.1.0");
        assert!(result.health.as_ref().unwrap().auth_status.authenticated);
        assert_eq!(result.health.as_ref().unwrap().providers, vec!["cortex"]);
        assert!(result.error.is_none());
        assert!(!result.server_error);
    }

    #[tokio::test]
    async fn test_check_core_health_server_error() {
        // Start a mock server that returns 503
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = tokio::io::BufReader::new(stream);
            let mut request_line = String::new();
            tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut request_line).await.unwrap();

            loop {
                let mut header = String::new();
                tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut header).await.unwrap();
                if header.trim().is_empty() {
                    break;
                }
            }

            let body = "Service Unavailable";
            let response = format!(
                "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );

            use tokio::io::AsyncWriteExt;
            let mut writer = tokio::io::BufWriter::new(reader.into_inner());
            writer.write_all(response.as_bytes()).await.unwrap();
            writer.flush().await.unwrap();
        });

        let url = format!("http://127.0.0.1:{}", port);
        let result = check_core_health(Some(url)).await;

        assert!(result.reachable, "Should be reachable");
        assert!(!result.compatible, "Should not be compatible");
        assert!(result.server_error, "Should be flagged as server error");
        assert!(result.error.is_some());
        assert!(result.error.as_ref().unwrap().contains("503"));
    }
}
