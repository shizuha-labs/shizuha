---
name: MCP Auth Identity Gap
description: Streamable HTTP transport doesn't pass per-request Authorization headers to tool handlers — all agents resolve as system@shizuha.com
type: project
---

## Problem

Platform MCP servers (Pulse, Wiki, etc.) are shared services. Multiple agents connect to the same server. Each agent sends its JWT in the Authorization header. But the FastMCP streamable HTTP transport doesn't propagate request headers to the tool handler context (ContextVar `request_ctx` is not set).

**Result**: `_get_effective_agent_token()` can't read the caller's token → falls back to the static `SHIZUHA_PULSE_JWT_TOKEN` env var → resolves to `system@shizuha.com` (user_id 999) → `pulse_get_my_tasks` returns no tasks.

**Why:** The Pulse MCP server generates a `system@shizuha.com` service token at startup (line 23-28 of pulse_server.py) for backend API auth. This same token is used as fallback identity when per-request headers aren't available.

## Root Cause

Two conflated concerns:
1. **Backend auth** — token for calling Pulse Django API (needs admin access)
2. **Caller identity** — who is the agent calling this tool (needed for `get_my_tasks`)

## Fix Options

1. **Fix ContextVar propagation** — make FastMCP's streamable HTTP handler set `request_ctx` with the original HTTP headers
2. **Separate service token from identity** — keep `system` token for API calls, but pass caller identity as a tool parameter
3. **Forward auth header explicitly** — the MCP server reads Authorization from the HTTP request (outside ContextVar) and stores it per-session

**How to apply:** The fix needs to be in `base.py` shared across all 14 MCP servers.
