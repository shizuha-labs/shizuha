# AgentCredential operations notes

## `update_agent.ssh_keys` deprecation shim

`update_agent(..., ssh_keys={...})` is a compatibility-only path for older callers.
It is available for a 30-day deprecation window ending **2026-07-05**.

During the window, enabled cron MCP `ssh_keys` updates are translated into:

```text
agent_grant_credential(
  grantee=<update_agent target>,
  scope="fleet-ssh",
  payload=<ssh_keys object>
)
```

The broker is therefore the source of truth for fleet SSH grants, and usage is
visible in the AgentCredential grant/audit stream. The shim validates the daemon
target first, defers this grant until any sibling `update_agent` config PATCH
succeeds, then requests a running-only restart so active container runtimes
restage the updated fleet-ssh grant without bringing stopped agents online.

Legacy non-enabled requests (`ssh_keys={"enabled": false}`, omitted `enabled`, or
other falsy `enabled` values) preserve the daemon-side reconciliation path for
the deprecation window. That keeps the old revoke/no-grant semantics: the daemon
removes or leaves absent the fleet-ssh grant representation and takes the same
running-only restart path it used before the shim. New automation must call the
broker primitive directly instead of adding new `ssh_keys` callers.

After the window closes, remove the shim in the follow-up S7 task and reject
`update_agent.ssh_keys` at the MCP schema/handler boundary.

## Credential broker grant rate limits

The broker enforces ADR-PLAT-001 S8 limits before accepting `grant_credential`:

- Grantor + scope: 5/min sustained, 10/min burst by default.
- Grantee: 5/min sustained, 10/min burst across all grantors and scopes.
- Circuit breaker: once either a grantor+scope or a grantee has 50 `grant_issued`
  audit rows in the trailing 60 minutes, new grants are blocked at 0/min and a
  local security alert is fired.

Defaults are configurable for test/staging rollouts with:

```text
SHIZUHA_CREDENTIAL_GRANT_RATE_LIMITS=0|1
SHIZUHA_CREDENTIAL_GRANT_RATE_LIMIT_SUSTAINED_PER_MINUTE=<positive integer>
SHIZUHA_CREDENTIAL_GRANT_RATE_LIMIT_BURST_PER_MINUTE=<positive integer>
SHIZUHA_CREDENTIAL_GRANT_CIRCUIT_BREAKER_GRANTS_PER_HOUR=<positive integer>
```

The circuit-breaker threshold is capped at 1000 grants/hour, matching the
indexed audit query page size used by the hot-path limiter.

Platform bootstrap grant agents may override only the grantor-side sustained
bucket. That override is never silent: the resulting `grant_issued` audit row
contains `rateLimitOverride=grantor-sustained` plus override actor/reason fields.
Grantee-side limits and circuit breakers remain mandatory.
