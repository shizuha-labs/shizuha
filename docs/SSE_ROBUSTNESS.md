# MCP SSE Connection Robustness

## Overview

Shizuha gateway agents connect to platform MCP servers (e.g., Pulse) via SSE (Server-Sent Events). SSE connections are long-lived HTTP streams that can silently die when the server restarts, the network blips, or the system sleeps. Without reconnection logic, tool calls fail silently and agents become non-functional.

This document describes the resilience patterns implemented in `src/tools/mcp/client.ts` (`SSEReconnectWrapper`), modeled after Claude Code's `SSETransport` (`vendor/claude-code-sources/.../cli/transports/SSETransport.ts`).

## Implemented Patterns

### 1. Exponential Backoff with Jitter

**What**: Reconnection attempts use exponential backoff (1s → 2s → 4s → ... → 30s cap) with ±25% jitter to prevent thundering herd.

**Claude Code reference**: `SSETransport.handleConnectionError()` — same formula.

**Config**: `SSE_RECONNECT_BASE_DELAY_MS = 1000`, `SSE_RECONNECT_MAX_DELAY_MS = 30000`

### 2. Permanent Close Code Detection

**What**: HTTP status codes 401, 403, 404 are treated as permanent — the wrapper stops retrying immediately instead of burning the 10-minute budget. Auth failure codes (4001, 4003) trigger a single header refresh + retry before giving up.

**Claude Code reference**: `WebSocketTransport` classifies close codes into permanent vs retryable. 4003 triggers token refresh.

**Why it matters**: Without this, an auth misconfiguration causes 10 minutes of futile retries before the agent realizes it can't connect.

### 3. Liveness Detection (Reactive Probe)

**What**: A 45-second timer fires if no successful tool call has occurred. On timeout, a `listTools()` probe with a 5-second deadline tests if the connection is alive. If the probe fails or times out, reconnection is triggered.

**Claude Code reference**: `SSETransport` uses server-sent keepalive frames every 15s with a 45s liveness timeout. Our approach is reactive (probes on demand) rather than proactive (server pushes keepalives), because the MCP SSE protocol doesn't define keepalive frames.

**Config**: `SSE_LIVENESS_TIMEOUT_MS = 45000`, probe deadline = 5s

### 4. Authentication Token Refresh

**What**: When a 4003 (unauthorized) error is detected, the wrapper refreshes auth headers from the connection config before retrying. This handles token expiry during long-running sessions.

**Claude Code reference**: `WebSocketTransport` calls `refreshHeaders()` on 4003, retries once.

**Implementation**: `refreshSseHeaders()` re-reads `config.headers` and updates `sseOpts.requestInit`.

### 5. System Sleep Detection

**What**: On liveness timeout, the wrapper checks if the wall clock jumped by more than 60s + liveness timeout. If so, the system likely slept and woke — the SSE connection is certainly dead. Reconnection happens immediately (skips backoff).

**Claude Code reference**: `WebSocketTransport` detects clock gaps >60s and reconnects immediately.

**Why it matters**: Without this, agents on laptops/edge devices wait the full backoff delay after wake before reconnecting, adding 1-30s of unnecessary latency.

### 6. Reconnection Time Budget

**What**: After 10 minutes of continuous reconnection attempts, the wrapper gives up permanently. Prevents infinite retry loops against permanently dead servers.

**Claude Code reference**: Same — `RECONNECT_GIVE_UP_MS = 600000` (10 minutes).

**Config**: `SSE_RECONNECT_GIVE_UP_MS = 600000`

### 7. Fresh Client on Reconnect

**What**: On reconnect, a new `Client` instance is created (not just a new transport). The MCP SDK's `Client` object maintains internal state that becomes stale after disconnection — creating a fresh one avoids "Already connected to a transport" errors.

**Why it matters**: The MCP SDK's `Client.connect()` throws if called on an already-connected client. Simply closing and reconnecting the same client instance is unreliable. Creating a fresh client guarantees clean state.

### 8. Tool List Refresh After Reconnect

**What**: After successful reconnection, `listTools()` is called to refresh the cached tool list. If the MCP server was restarted with new tool definitions (e.g., added `workflow` parameter to `pulse_create_task`), agents get the updated schema automatically.

**Why it matters**: Without this, reconnecting to a server with changed tools would cause -32602 (invalid params) errors because the agent's cached schema doesn't match the server's.

## Deferred Patterns

### Message Buffering + Replay
Claude Code buffers outgoing messages and replays them on reconnect using sequence numbers (`Last-Event-ID`). The MCP SDK's `SSEClientTransport` doesn't expose sequence tracking, so this would require wrapping the transport layer. Deferred because MCP tool calls are request-response (not fire-and-forget) — the agent retries failed calls naturally.

### Duplicate Detection
Claude Code tracks seen sequence numbers to prevent re-processing duplicated events on reconnect. Not needed without message buffering.

### Server Retry-After Header
Claude Code respects `Retry-After` headers from the server to override backoff timing. Deferred because MCP SSE servers (our Pulse) don't send `Retry-After`. Would be straightforward to add if needed.

### Backpressure Queue Limit
Claude Code caps pending message queues at 100K entries. Deferred because shizuha agents process tool calls sequentially — no unbounded queue accumulation.

## Architecture

```
Agent Container
├── Gateway Process
│   ├── Agent Loop (plan → act → observe)
│   ├── Tool Registry
│   │   └── MCP Client (src/tools/mcp/client.ts)
│   │       ├── SSEClientTransport (MCP SDK — bare, no reconnection)
│   │       └── SSEReconnectWrapper (our layer — Claude Code-style resilience)
│   │           ├── onerror handler → handleConnectionLoss()
│   │           ├── onclose handler → handleConnectionLoss()
│   │           ├── Liveness timer (45s) → probe → reconnect if dead
│   │           ├── Sleep detection (clock gap > 60s) → immediate reconnect
│   │           ├── Permanent code detection (401/403/404) → fail fast
│   │           ├── Auth refresh (4003) → refreshHeaders() + retry once
│   │           └── Exponential backoff (1s-30s, ±25% jitter, 10min budget)
│   └── Channels (HTTP/WS, Telegram, Discord, etc.)
└── MCP SSE Server (shizuha-pulse container, port 18101)
```

## Testing

To test reconnection manually:

```bash
# 1. Verify initial connection
docker logs shizuha-agent-shizuha --since 1m 2>&1 | grep "MCP connected"

# 2. Kill the MCP server
docker exec shizuha-pulse supervisorctl restart mcp-server

# 3. Watch reconnection (should happen within seconds)
docker logs -f shizuha-agent-shizuha 2>&1 | grep -E "SSE|MCP connected|reconnect"

# Expected output:
# MCP SSE error detected: "SSE error: TypeError: terminated: other side closed"
# MCP SSE scheduling reconnect (attempt 1, delay ~1000ms)
# MCP SSE reconnected successfully (71 tools)
```

## Configuration

All constants are in `src/tools/mcp/client.ts`:

| Constant | Value | Description |
|----------|-------|-------------|
| `SSE_RECONNECT_BASE_DELAY_MS` | 1000 | Initial backoff delay |
| `SSE_RECONNECT_MAX_DELAY_MS` | 30000 | Maximum backoff delay |
| `SSE_RECONNECT_GIVE_UP_MS` | 600000 | Total time budget (10 min) |
| `SSE_LIVENESS_TIMEOUT_MS` | 45000 | Liveness probe trigger interval |

## References

- Claude Code SSETransport: `vendor/claude-code-sources/claw-cli-claude-code-source-code-v2.1.88/src/cli/transports/SSETransport.ts`
- Claude Code WebSocketTransport: `vendor/claude-code-sources/.../cli/transports/WebSocketTransport.ts`
- MCP SDK SSEClientTransport: `node_modules/@modelcontextprotocol/sdk/dist/cjs/client/sse.js`
