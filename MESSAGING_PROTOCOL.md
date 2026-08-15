# Messaging Protocol

All messaging (human↔human, human↔agent, agent↔agent) flows through **shizuha-connect**. Agents are first-class participants — they connect to Connect the same way humans do, with persistent WebSocket connections and the same event vocabulary.

## Architecture

```
Dashboard (Browser)              Kotlin App               Agent Container
     │                              │                          │
     │ JWT auth                      │ JWT auth                 │ Agent JWT auth
     │                              │                          │
     ▼                              ▼                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                     shizuha-connect                              │
│                                                                  │
│  UserChatConsumer          UserChatConsumer     AgentChatConsumer │
│  (1 WS per human)         (1 WS per human)     (1 WS per agent) │
│                                                                  │
│  Multiplexed across all conversations via channel groups         │
│  Real-time: Django Channels + Redis channel layer                │
│  Persistence: DirectMessage model in PostgreSQL                  │
└──────────────────────────────────────────────────────────────────┘
```

**Key principles**:

1. **1 persistent WebSocket per user (or agent)** — not per conversation. Multiplexed via channel groups.
2. **WebSocket-only for clients.** Every client that speaks to Connect — dashboards, Kotlin/iOS apps, ori-expo, third-party integrations — MUST use the WebSocket for send, receive, read-receipts, typing, and history replay. **No REST fetches for messages, history, or receipts** in normal operation. REST endpoints exist (`GET /connect/api/conversations/{id}/messages/`) as an **emergency-recovery safety net** only — useful during bootstrap, migrations, or when a client has completely lost its local cache and needs a one-shot resync. In steady-state operation (page reload, app resume, network flap), clients rely on the WS's built-in `missed_message` replay instead.
3. **One exception — agents using `message_user` MCP.** The `message_user` tool is a lightweight SDK wrapper agents can call without managing a WS themselves. It posts via REST to a Connect-internal endpoint that persists + broadcasts the same as a WS `send_message`. Agents that run `ConnectClient` already have a WS and should prefer it; agents running only the MCP stub can use the REST shortcut. Nothing else gets to bypass WS.

## WebSocket Endpoints

| Endpoint | Consumer | Purpose | Auth |
|----------|----------|---------|------|
| `/connect/ws/connect/user/` | `UserChatConsumer` | Multiplexed WS for human users | `?token=<JWT>` |
| `/connect/ws/connect/agent/` | `AgentChatConsumer` | Multiplexed WS for AI agents | `?token=<agent_JWT>` |
| `/connect/ws/connect/chat/{conv_id}/` | `ChatConsumer` | Per-conversation WS (legacy, still supported) | `?token=<JWT>` |

## Connection Lifecycle

### Human (Dashboard / Kotlin)

1. Authenticate with shizuha-id → obtain JWT
2. Connect to `UserChatConsumer` WS with `?token=<JWT>`
3. Server joins all `chat_{conversation_id}` groups for the user's conversations
4. Server pushes missed messages since `last_read_at`
5. Client sends `ping` every 30s; server responds with `pong`
6. On disconnect, server removes from all groups

### Agent (Container)

1. Self-authenticate: `POST /id/api/auth/login/` with `AGENT_USERNAME` + `AGENT_PASSWORD` → JWT
2. Connect to `AgentChatConsumer` WS with `?token=<agent_JWT>`
3. Server joins all `chat_{conversation_id}` groups for the agent's conversations
4. Agent receives `new_message` when humans send messages in any conversation
5. Agent sends streaming response events via `stream_event`
6. On `complete`, server persists `DirectMessage` and broadcasts `new_message` to group

## Message Send Flow

### Human sends a message

```
Human Client                    Connect Service                    Agent
    │                                │                                │
    │ send_message                   │                                │
    │ {type:"send_message",          │                                │
    │  conversation_id, content,     │                                │
    │  client_message_id}            │                                │
    │──────────────────────────────> │                                │
    │                                │ persist DirectMessage          │
    │                                │ group_send → chat_{conv_id}    │
    │                                │                                │
    │                                │ new_message ──────────────────>│
    │                                │ (agent receives human's msg)   │
    │                                │                                │
    │                                │ <── stream_event (session_start)│
    │                                │ <── stream_event (content)     │
    │ <── agent_stream (content)     │ <── stream_event (content)     │
    │ <── agent_stream (content)     │     ...                        │
    │                                │ <── stream_event (complete)    │
    │                                │     persist DirectMessage      │
    │ <── new_message (final)        │     group_send new_message     │
    │                                │                                │
```

## Event Vocabulary

### Client → Server (UserChatConsumer)

| Event | Fields | Description |
|-------|--------|-------------|
| `ping` | — | Keepalive |
| `send_message` | `conversation_id`, `content`, `client_message_id` | Send a message |
| `typing_start` | `conversation_id` | User started typing |
| `typing_stop` | `conversation_id` | User stopped typing |
| `message_read` | `conversation_id`, `message_id` | Mark message as read |

### Server → Client (UserChatConsumer)

| Event | Fields | Description |
|-------|--------|-------------|
| `pong` | — | Keepalive response |
| `new_message` | `conversation_id`, `message` | New message in a conversation |
| `missed_message` | `conversation_id`, `message` | Message received while disconnected |
| `agent_stream` | `conversation_id`, `event_type`, `agent_id`, `data` | Agent streaming event |
| `typing` | `user_id`, `is_typing` | Typing indicator |
| `message_read` | `user_id`, `message_id` | Read receipt |
| `message_delivered` | `user_id`, `message_id` | Delivery receipt |
| `conversation_created` | `conversation_id`, `conversation` | Added to new conversation |
| `message_edited` | `message` | Message was edited |
| `message_deleted` | `message_id` | Message was deleted |

### Agent → Server (AgentChatConsumer)

| Event | Fields | Description |
|-------|--------|-------------|
| `ping` | — | Keepalive |
| `stream_event` | `conversation_id`, `event_type`, `data` | Streaming response event |
| `typing_start` | `conversation_id` | Agent typing |
| `typing_stop` | `conversation_id` | Agent stopped typing |
| `message_read` | `conversation_id`, `message_id` | Mark message as read |

### Streaming Event Types (`event_type` in `stream_event`)

| Type | Data Fields | Description |
|------|-------------|-------------|
| `session_start` | `message_id` | Agent began processing |
| `content` | `delta` | Incremental text content |
| `reasoning` | `summaries` | Thinking/reasoning output |
| `tool_start` | `tool`, `tool_call_id` | Agent started using a tool |
| `tool_complete` | `tool`, `duration_ms`, `is_error` | Tool execution finished |
| `complete` | `content` | Agent finished response (persisted as DirectMessage) |
| `error` | `error` | Agent encountered an error |

### Server → Agent (AgentChatConsumer)

| Event | Fields | Description |
|-------|--------|-------------|
| `pong` | — | Keepalive response |
| `new_message` | `conversation_id`, `message` | Human sent a message |
| `conversation_created` | `conversation_id`, `conversation` | Agent added to new conversation |
| `typing_indicator` | `conversation_id`, `user_id`, `is_typing` | Human typing |

## Streaming Lifecycle

One agent response consists of:

1. `session_start` → broadcast as `agent_stream` to all human clients
2. Zero or more `content` deltas → broadcast as `agent_stream` (ephemeral, not persisted)
3. Zero or more `tool_start` / `tool_complete` pairs → broadcast as `agent_stream`
4. `complete` → **persisted** as `DirectMessage`, broadcast as `new_message` (not `agent_stream`)
5. OR `error` → broadcast as `agent_stream`, no persistence

**Important**: Only `complete` events are persisted. Content deltas are ephemeral — they provide real-time streaming but the final message is the single `new_message` from the `complete` event.

## Channel Layer Groups

Connect uses Django Channels with Redis channel layer for real-time broadcasting:

| Group | Members | Events |
|-------|---------|--------|
| `chat_{conversation_id}` | All `UserChatConsumer` and `AgentChatConsumer` instances for participants | `new_message`, `agent_stream_event`, `typing_indicator`, `message_read_receipt` |
| `user_inbox_{user_id}` | `UserChatConsumer` for this user | `conversation_created` |
| `agent_inbox_{user_id}` | `AgentChatConsumer` for this agent | `conversation_created` |

## Agent Self-Authentication

Agents authenticate to shizuha-id using username/password (same as humans):

1. Container has `AGENT_USERNAME`, `AGENT_PASSWORD`, `SHIZUHA_PLATFORM_URL` env vars
2. `ConnectClient` (shared TypeScript module) POSTs to `/id/api/auth/login/`
3. Receives JWT with `user_id`, `is_agent` claim
4. Uses JWT to connect to `AgentChatConsumer` WS
5. Re-authenticates automatically if JWT expires (1h lifetime)

## Message Identity Headers

All messages injected into agent sessions carry sender identity headers, enabling multi-user support and audit trails.

**Human → Agent:**
```
[Message]
From: Hritik Soni (user_id: 3)

<message content>
```

**Agent → Agent (via `message_agent` tool):**
```
[Agent Message]
From: @akira (Security Engineer)
Reply to: @akira (use message_agent tool)

<message content>
```

This ensures agents always know who they're talking to, regardless of whether the sender is human or another agent.

## Provider Failover Chains

Named failover chain policies define an ordered list of provider/model combos. When one fails (rate limit, error, timeout), the system automatically tries the next. Each agent can be assigned a chain; unassigned agents use the "default" chain.

### Chain Structure

```json
{
  "id": "claude-primary",
  "name": "Claude Primary",
  "steps": [
    {"method": "claude_code_server", "model": "claude-opus-4-6", "thinkingLevel": "on", "reasoningEffort": "max"},
    {"method": "claude_code_server", "model": "claude-sonnet-4-6", "thinkingLevel": "on", "reasoningEffort": "high"},
    {"method": "codex_app_server", "model": "gpt-5.3-codex", "reasoningEffort": "high"},
    {"method": "shizuha", "model": "Qwen/Qwen3.5-32B-FP8"}
  ]
}
```

### Failover Flow

```
Rate limit on claude-opus-4-6
  ├── Step 1: Rotate OAuth tokens (try all 6 tokens for same model)
  ├── Step 2: Switch to claude-sonnet-4-6 (reset token pool, try all tokens)
  ├── Step 3: Exit code 42 → daemon restarts with codex_app_server/gpt-5.3-codex
  └── Step 4: If codex fails → daemon restarts with shizuha/Qwen3.5-32B-FP8 (local vLLM)
```

### API

- `GET /v1/failover-chains` — list all chains
- `POST /v1/failover-chains` — create chain
- `PUT /v1/failover-chains/:id` — update chain
- `DELETE /v1/failover-chains/:id` — delete chain (blocked if agents reference it)
- `PATCH /v1/agents/:id` with `failoverChainId` — assign chain to agent

### Agent Assignment

- Per-agent via `failoverChainId` field in agent config
- Falls back to inline `modelFallbacks` (backward compat)
- Falls back to chain with `id: "default"` if no inline fallbacks

## Agent Runtime Integration

Agent containers run bridge processes (claude-bridge, codex-bridge, openclaw-bridge) that:

1. Start `ConnectClient` on boot → self-auth → connect to `AgentChatConsumer`
2. Receive `new_message` → queue for execution
3. Execute via LLM (Claude, Codex, etc.) → produce streaming events
4. Forward streaming events via `ConnectClient.forwardBridgeEvent()` → `stream_event` on WS
5. `AgentChatConsumer` handles persistence and broadcasting

The `ConnectClient` is a shared module (`src/connect-client/index.ts`) used by all bridge types — DRY.

## Client Implementations

### Dashboard (Browser)

- Browser's `ConnectBridge` (`src/web/lib/connect-bridge.ts`) connects directly to the daemon's mini-Connect WS (`/connect/ws/connect/user/`), which proxies transparently to real Connect when linked. Single origin = no CORS / Origin gotchas.
- Sends messages via WS `send_message` (no REST). All message I/O flows over this one socket.
- Receives `new_message` (live) and `missed_message` (reconnect replay) through one handler — both unwrap the same `ConnectMessage` payload into the dashboard's internal event shape.
- Receives `agent_stream` for streaming content/reasoning/tool events (rendered in Activity tab, not chat).
- Maps `conversation_id` → `agent_id` for routing to browser subscribers.
- Keepalive ping every 30s with stale connection detection (60s timeout).
- **Never fetches chat history via REST** in normal operation. On page refresh, the dashboard opens a new WS; the server's `_push_missed_messages` handshake pushes everything since `last_read_at` as `missed_message` events.

### Kotlin App (Android)

- `WebSocketClient` connects to `UserChatConsumer` via `wss://host/connect/ws/connect/user/`
- Handles `new_message`, `agent_stream`, `typing` events directly (no bridge wrapper)
- `ConnectViewModel` processes events → upserts into Room DB → UI auto-updates
- `ConversationDetailScreen` observes Room DB via Flow for real-time rendering
- Conversation list shows only Connect conversations (no old agent chat entries)

## Conversation Model

- `Conversation` — group or DM conversation with participants
- `ConversationParticipant` — links users (human or agent) to conversations
- `DirectMessage` — individual message with `sender_id`, `content`, `sender_is_agent` flag
- Both humans and agents are regular `user_id` participants — no special agent tables for messaging

## Message Persistence & History

Connect is the **single source of truth** for all messages (like WhatsApp Server). Clients are thin — they fetch history from Connect and cache locally.

### Persistence Model

| Layer | Storage | Scope |
|-------|---------|-------|
| Connect (server) | PostgreSQL `DirectMessage` table | Permanent, authoritative |
| Kotlin app | Room DB (`connect_messages` table) | Local cache, survives app restarts |
| Dashboard (browser) | In-memory + WS `missed_message` replay on refresh | IndexedDB cache for instant-load is a pending enhancement — see TODO |

### History Replay on Connect/Reconnect — WS-driven

On every fresh WS connection (including page refresh, app resume, network-flap reconnect):

1. **`UserChatConsumer._push_missed_messages`** runs as part of the `connect()` handshake. For every conversation the user participates in, it queries `DirectMessage` rows since that participant's `last_read_at` (or falls back to now–30 min when unset) and sends each one as a separate `missed_message` WS event.
2. Clients handle `missed_message` with the **same logic as `new_message`** — the payload shape is identical; it's just a different `type` discriminator so the UI can optionally surface "catching up" state.
3. Clients mark messages read via `message_read` WS events. The server updates `last_read_at` on the participant row, shrinking the next reconnect's replay set. Without this, every reconnect re-sends the same 30-min window.
4. The combined effect: the WS is the single authoritative channel. A client that stays connected sees messages live; a client that reconnects sees them as `missed_message`s; a client that drops for longer than 30 min without marking read may lose older messages — in which case it's a true cache-loss scenario and the REST emergency-recovery path applies.

**REST is not the normal history path.** `GET /connect/api/conversations/{id}/messages/` exists for one-shot recovery (fresh install, cache wipe, first-time load before a WS is ever opened, or admin tooling) — not for routine page loads. Building clients that call it on every refresh defeats the `last_read_at` bookkeeping and masks bugs in the WS replay path.

### Client-Side Cache

Clients SHOULD keep a local cache of recent messages (Kotlin uses Room DB; dashboards should use IndexedDB). The cache is a UX optimization — it lets the chat panel render instantly on open while the WS's `missed_message` stream fills in anything the cache missed. The cache is NEVER the source of truth: on conflict, Connect wins.

### Reliability Guarantees

- Messages are persisted in Connect's PostgreSQL on creation (both human `send_message` and agent `complete`)
- Streaming events (`content`, `tool_start`, etc.) are **ephemeral** — not persisted, not replayed
- The `complete` event triggers persistence — if a client disconnects mid-stream, it gets the final message on reconnect via `missed_message` or history fetch
- Multi-device: messages sent from one device (dashboard) appear on all other devices (Kotlin) via `new_message` broadcast. Only the originating WS connection is suppressed (not all connections for the same user)

### Message Identity

- `id`: UUID assigned by Connect on creation (server-authoritative)
- `client_message_id`: client-generated UUID for dedup (sent with `send_message`, stored in DB)
- Server-side senders must pass a valid UUID or omit it and let the shared Connect DM helper generate/normalize one; never send a human-readable idempotency key directly.
- For optimistic UI: client shows message with `client_message_id` immediately, replaces with server `id` when `new_message` arrives

## Message Ordering

**Connect is the single source of truth for ordering.** The `DirectMessage.created_at` column (server-assigned via `auto_now_add`, microsecond precision) is the authoritative ordering field, and `Meta.ordering = ['created_at']` on the model enforces it in all queries.

### Ordering contract — all clients MUST obey this

1. **Sort key**: render messages ordered by `(seqNum ASC, createdAt ASC, id ASC)`. `seqNum` is an optional per-agent-event-log sequence number supplied by the daemon (for dashboard) or absent (Kotlin/cross-device DMs — falls back to `createdAt`).
2. **`createdAt` is server-authoritative** — the value sent by Connect in `new_message` / `missed_message` / history responses. Clients must NOT replace it with a local clock value.
3. **Optimistic local messages** (user typed on this device, not yet echoed back) use `createdAt = new Date().toISOString()` from the local clock with a `pending: true` flag. The moment Connect echoes the message back (either via `new_message` matching `client_message_id` or via `user_message` event with matching `request_id`), the client **replaces** the provisional entry with the server version — server `id`, server `createdAt`, server `seqNum`. Do not keep the local timestamp.
4. **Every insertion path uses one helper** — not scattered `[...prev, msg]` + occasional sort. The helper does insert-by-key so out-of-order arrivals land in the right slot without a full re-sort.
5. **Clock skew defense**: between client clocks on the same account, differences of 100s of ms are normal and would otherwise flip adjacent messages. Always prefer server-stamped `createdAt`; never compare two client-stamped timestamps from different devices.

### Why `(seqNum, createdAt, id)` and not just `createdAt`

- **`seqNum`** — from the shizuha-agent daemon's event log. Strictly monotonic within one agent's event stream. Used for agent-internal events that don't touch Connect (tool calls, reasoning, status updates). Lets the dashboard interleave streaming-only events with persisted DM events deterministically.
- **`createdAt`** — authoritative across devices and users. Present on every persisted DirectMessage. Primary key for humans-only and agent-final-reply ordering.
- **`id`** — stable tiebreaker when two messages share both keys (rare, but possible in tests or clock collisions).

### Per-client expectations

- **Dashboard (browser)**: uses `insertOrdered(prev, msg)` in `useChat.ts` for every state mutation. Replaces pending local user messages with server-echoed versions. Render component does no additional sort.
- **Kotlin app**: Room DB query is `ORDER BY created_at ASC, id ASC`. Optimistic sends insert a row with a local `created_at` and a `pending = true` flag; on server echo the row is updated in place with server values. Render observes via Flow; no client-side sort.
- **Agent container**: doesn't render messages, so ordering only matters when the LLM receives the inbox — agents see messages in arrival order from Connect, which is already `created_at ASC` via the model's default ordering.

### What this prevents

- Typing B while A's reply is streaming, then A's `complete` event arrives with a `createdAt` slightly BEFORE B's local timestamp → reply inserts above B, making the conversation read "A → reply → B → B's reply" when it should be "A → B → reply → reply".
- Clock-skewed multi-device send: laptop clock is 800ms fast, phone clock on time; phone-sent message arrives with earlier server `createdAt` but later local echo, reorders above already-rendered laptop message.
- `event_replay` on reconnect interleaving with live events mid-stream.

## Connection Reliability

### Channel Layer Configuration

```python
CHANNEL_LAYERS = {
    'default': {
        'CONFIG': {
            'expiry': 3600,  # 1 hour — group memberships must outlive keepalive intervals
        },
    },
}
```

**Critical**: `expiry` must be >> keepalive interval (30s). With `expiry: 120` (2 min), group memberships silently expire between pings, causing message loss without any error.

### Server-Initiated Keepalive

Both `UserChatConsumer` and `AgentChatConsumer` run a background keepalive loop:

1. **Ping every 30s** — server sends `{"type":"ping"}` to client, client responds with `{"type":"pong"}`
2. **Group re-subscription every 5 min** — calls `_join_all_groups()` to refresh Redis group memberships, preventing silent expiry
3. **Dead connection detection** — if ping send fails, loop exits and connection closes cleanly

### Client-Initiated Keepalive

Both Kotlin app and daemon send their own ping every 30s:
- If no pong received within 60s, connection is considered dead → close + reconnect
- Kotlin: exponential backoff reconnect (10 attempts, 30s max delay, ±20% jitter)
- Daemon: simple 3s retry on close

### Multi-Device Support

Multiple devices connecting as the same user each get their own `UserChatConsumer` instance. Each instance:
- Has its own `channel_name` (unique per WS connection)
- Joins the same `chat_{conv_id}` groups independently
- Receives broadcasts independently via `group_send`
- No connection displacement — new connections don't close old ones

`origin_channel` is used to prevent echo: a device that sent a message won't receive its own `new_message` back, but all OTHER devices for the same user will.

### Sync-on-Open Safety Net

Even with persistent WS connections, there are edge cases where catch-up is needed (app backgrounded for longer than the 30-min `missed_message` cutoff, fresh install with an empty local cache, participant joined a new conversation mid-session).

- **Kotlin**: `syncConversationMessages()` fetches the latest 200 messages from the Connect REST API only when a conversation is first opened (or the Room cache is empty for it). Subsequent opens use the cached rows + live WS.
- **Dashboard**: same pattern — the primary history channel is `missed_message` over WS. A one-shot REST sync is acceptable on first-ever login (when there's no IndexedDB cache yet) but must NOT run on every page refresh. Refreshes are handled entirely by the `missed_message` events the server pushes during the new WS handshake.

## Resilience Contract — What Every Connect Client MUST Implement

Treat Connect like WhatsApp: server is the single source of truth; clients are thin caches; every client sees the same conversation consistently regardless of device, tab, or when it last connected. The rules below are **required** for every Connect client — dashboard, Kotlin, ori-expo, any future integration. Drift from this contract produces the bugs we keep relearning: missing history on refresh, duplicate bubbles, ghost messages, out-of-order rendering.

### Contract (do)

1. **Send path**: generate a `client_message_id` (UUID v4) per outgoing message. Insert an optimistic entry locally with that id + `pending: true`. Send via WS `send_message`. On receipt of `new_message` with matching `client_message_id`, replace the optimistic entry with the server version (`id`, `createdAt`, `seqNum` if present). Never keep the local timestamp after the echo lands.
2. **Receive path**: treat `new_message` and `missed_message` as **the same event** — only the `type` discriminator differs. Route both through the same upsert helper.
3. **Ordering**: render by `(seqNum ASC, createdAt ASC, id ASC)`. Never compare two client-stamped timestamps from different devices.
4. **Dedup**: an incoming message is a dup of a local entry if ANY of these match: same server `id`; same `client_message_id`; or (pending + same role + same content). First-match wins; insert-in-place replaces.
5. **Live receive**: join `chat_{conv_id}` groups on WS connect; server does this automatically via `_join_all_groups`. Clients don't subscribe per-conversation manually.
6. **Reconnect**: exponential backoff (1s→30s over ~10 attempts), then fall back to a steady 30-60s retry. Refresh the JWT before retrying after auth failure (401 on upgrade). On successful reconnect, the server will push `missed_message`s — do NOT fetch REST unless the cache says this is a first-ever open (see below).
7. **First-ever open of a conversation** (no cache for this conversation id): do a ONE-SHOT REST fetch of the latest N (200 is fine) messages via `GET /connect/api/conversations/:id/messages/?limit=200`, feed each through the same upsert helper as `missed_message`. After this, the WS's `missed_message` stream keeps the cache fresh on subsequent opens.
8. **Read receipts**: on seeing a new message for a conversation the user is actively viewing, send `message_read` WS event for the newest visible message. This is not optional — without it, `last_read_at` never advances and every reconnect re-replays the same 30-minute window.
9. **Offline sends**: queue outgoing `send_message`s while WS is closed; flush in FIFO order on reconnect. The server enforces `UNIQUE(conversation_id, client_message_id)` so replaying a send that already landed is a no-op (server returns the existing `DirectMessage`).
10. **Local cache**: persist recent messages per conversation (Room DB / IndexedDB / SQLite — whatever the platform offers). Cache is a UX optimisation, never truth. On conflict, Connect wins.
11. **Keepalive**: send `{type:"ping"}` every 30s; if no `pong` within 60s, treat the socket as dead and reconnect. The server also pings — respond with `pong` promptly.

### Anti-contract (don't)

- **Don't** fetch REST history on every page refresh. That's what `missed_message` is for.
- **Don't** open a separate WS per conversation. One WS per user (or agent); multiplex via `chat_{conv_id}` groups.
- **Don't** treat `agent_stream` events as chat bubbles. Those are streaming UX hints — per-token content, tool starts, reasoning — and belong in an activity/reasoning panel, never in the chat scroll. The agent's **final reply** arrives as a single persisted `new_message` when it calls `message_user`.
- **Don't** dedup by content alone across devices — two different users can legitimately type the same string. Dedup by `client_message_id` + server `id` + (pending role+content) only.
- **Don't** re-replace a server-echoed message with a later optimistic one when the user edits. Edits go through `message_edited`, not through a fresh `send_message`.
- **Don't** silently drop messages whose `sender_id` you don't recognise. Show them with the name the server provides (`sender_name` / `sender_username`) — an unknown participant usually means the user was added to a group.
- **Don't** invent a `seqNum` client-side. The dashboard's daemon assigns a local event-log seq for mixed streaming + DM ordering; Kotlin / ori-expo don't have one and use `createdAt` exclusively. That's fine — the ordering helper handles both.

### Platform-specific compliance (2026-04-19 audit)

| Client | Receive path | CMID dedup | Ordering | Cache | First-load REST | Offline queue | Read receipts |
|---|---|---|---|---|---|---|---|
| Kotlin Android | WS `UserChatConsumer` → Room DB upsert → Flow → UI | ✅ `atomicReplaceByClientId` (`ConnectRepository:653`) | ✅ `(createdAt, id)` tri-key in Room DAO (`ConnectDao.kt:77`, added 2026-04-19) | Room DB (`connect_messages`), survives app restart | ✅ `refreshConversationMessages()` (`ConnectRepository:84`) | ✅ Failed sends are Room-persisted (survive app kill); auto-retry on conversation open + WS reconnect (`ConnectViewModel.init`, added 2026-04-19). Server UNIQUE(conversation_id, client_message_id) keeps retries idempotent. | ✅ `sendChatReadReceipt()` on every messages-list change (`ConversationDetailScreen.kt:329-334`) |
| ori-expo (RN) | WS → in-memory store → React re-render | ✅ server-side unique constraint + client_message_id on send | ⚠️ `createdAt` only | ✅ AsyncStorage per-conversation cache (`useConversationChat.js:73`) | ✅ `fetchMessages(token, convId, {limit:50})` on mount (`useConversationChat.js:86`) | ✅ `_messageQueue` mirrored to AsyncStorage; hydrated on WS construct, persisted on enqueue, cleared on flush (`connectWebSocket.js`, added 2026-04-19) | ✅ `connectWebSocket.sendReadReceipt()` on every new_message (`useConversationChat.js:203`) |
| Dashboard (browser) | WS via `ConnectBridge` → `useChat` hook → React | ✅ `insertOrdered` rule 0 by `clientMessageId` (2026-04-19) | ✅ `(seqNum, createdAt, id)` tri-key in `chat-sync.ts` | ✅ IndexedDB via `connect-cache.ts` — 100% hydration in ~1.2s post-refresh (2026-04-19) | ✅ `bridge.syncConversationHistory()` on first open (2026-04-19) | ✅ `outbox` persisted to localStorage, auto-flush on WS open; server UNIQUE constraint keeps replays idempotent (2026-04-19) | ✅ `bridge.sendReadReceipt()` on conversation open + tab visibility (2026-04-19) |
| Daemon (relay) | Forwards WS between browser and upstream Connect; does not render. On `sync`, MUST emit exactly one `event_replay` (can be empty) so the client's replay gate clears. | N/A | N/A | N/A | N/A | N/A | N/A |

**Legend**: ✅ conforms · ⚠️ partial — works most of the time but drifts at edges · ❌ not implemented

**2026-04-19 update**: All three clients — Dashboard, Kotlin, ori-expo — achieve WhatsApp-grade compliance on the Resilience Contract. Shipped this session: dashboard CMID-dedup, first-load REST, IndexedDB cache, persistent outbox, read receipts, logout; Kotlin ordering tiebreaker + auto-retry-on-reconnect; ori-expo persistent outbox (AsyncStorage-backed). Earlier audit reports that claimed Kotlin/ori-expo lacked read receipts were wrong — both already had them wired; the audit missed the existing code paths. Remaining at the client layer: minor polish (IndexedDB-backed ordering, per-conversation seq_num once server exposes it). Remaining at the server layer: Kafka-backed event log (future, biggest server-side robustness win).

### Dashboard-specific: two-WS architecture

The dashboard is the only client that runs **two** WebSockets side-by-side:

- `/connect/ws/connect/user/` via `ConnectBridge` — the real chat channel. Every bubble the user sees comes from here.
- `/ws/chat` (daemon-internal) — streaming session events for the Activity panel: `session_start`, `content` deltas, `tool_start`, `tool_complete`, session-end stats. **Never renders chat bubbles.**

When both are up, `useChat`'s source-discipline filter drops bubble-rendering events (`user_message`, `complete`, `proactive_message`) arriving over `/ws/chat` unless they're tagged `_source: 'connect-bridge'` (set by the bridge on every event it emits). Without this, the agent's private session text (thoughts, tool monologues, session-end stats) leaks into the chat panel — see the "Silence — echo of my transition" bug history.

### Server responsibilities

Connect / mini-Connect MUST:

1. Push `missed_message` for every message since the participant's `last_read_at` on WS connect.
2. Persist DirectMessage atomically on `send_message` (or REST DM POST). Enforce `UNIQUE(conversation_id, client_message_id)` for idempotent retries.
3. Broadcast `new_message` to every `chat_{conv_id}` member EXCEPT the originating WS `channel_name` (self-echo suppression). Other tabs / devices of the same user MUST receive the echo.
4. Refresh channel-layer group memberships on a 5-min timer (Redis expiry defence).
5. Respond to client `ping` with `pong` within a few hundred ms.

## TODO / Future

**Client completeness** (concrete, each a single-client rebuild):
- [ ] **Kotlin read receipts** — `sendReadReceipt(conversationId, messageId)` over existing WS on new message visible + `ConversationDetailScreen` onResume. Mirror dashboard.
- [ ] **Kotlin persistent offline outbox** — Room table `outbox(conversation_id, content, client_message_id, enqueued_at)`. Flush on WS open. Replace the existing "pending >30s → failed" transition.
- [ ] **Kotlin ordering tiebreaker** — add `id` as secondary sort after `created_at` in Room DAO queries.
- [ ] **ori-expo read receipts** + **persistent outbox** + **REST first-load sync** — same three-piece set as dashboard.
- [ ] **Dashboard scroll-back pagination** — when user scrolls to top, fetch older messages via REST `before=<oldest_message_id>` (existing endpoint supports it); merge into state via `insertOrdered`.

**Server-side** (Connect improvements):
- [x] ~~Per-conversation `seq_num`~~ — landed 2026-04-20 as `DirectMessage.conversation_seq_num`, populated by BEFORE INSERT trigger under per-conversation advisory lock. Serializer aliases to `seqNum` in payload. Backfill assigns chronological order per conversation.
- [x] ~~`history` WS event~~ — landed 2026-04-20 as `{type:"history", conversation_id, before_event_id, limit}` → `history` response frame.
- [x] ~~Event-log / cursor replay~~ — landed 2026-04-20 as Postgres sequence + `event_id` BIGINT on DirectMessage (globally monotonic) + `last_read_event_id` on participant. `{type:"sync", since_event_id:N}` WS frame → replay delta + `sync_complete` ack. Kafka is no longer the path — Postgres sequence + trigger gives the same guarantee (no message loss regardless of disconnect duration) with zero operational overhead.
- [ ] Unify `UserChatConsumer` + `AgentChatConsumer` into single `ChatConsumer`.
- [ ] Reactions, edits, deletes fully over WS (verify every mutation endpoint has a WS equivalent).
- [ ] End-to-end encryption for DMs.
- [ ] File/media attachments via WS.
- [ ] Presence (online/offline) via Connect WS (currently via separate `ConnectConsumer`).

### Status snapshot (2026-04-20)

- ✅ **Dashboard**: WhatsApp-grade + K1/K4/K5 cursor replay. CMID dedup, (seqNum, createdAt, id) ordering, IndexedDB cache, first-load REST sync, read receipts, persistent localStorage outbox, **localStorage cursor `shizuha_connect_cursor_v1` sent as `since_event_id` on every WS open**, keepalive, exponential backoff.
- ✅ **Kotlin**: WhatsApp-grade + K1/K4/K5. Same dedup/ordering/cache/receipts, auto-retry-on-reconnect for failed sends (Room persists across app kill), **SharedPreferences-backed `connectEventCursor` sent as `since_event_id` on WS open**, `history` frame handler wired for scroll-back pagination.
- ✅ **ori-expo**: WhatsApp-grade + K1/K4/K5. Same dedup/ordering/cache/receipts, AsyncStorage-backed persistent outbox, **AsyncStorage-backed `connect_cursor_v1` sent as `since_event_id` on WS open**, `history` handler wired.
- ✅ **Server**: Event-log cursor replay. `DirectMessage.event_id` (BIGSERIAL) and `conversation_seq_num` (per-conversation) auto-assigned by BEFORE INSERT trigger under advisory lock. `ConversationParticipant.last_read_event_id` advances on every `message_read` receipt. `UserChatConsumer` handles `{type:"sync", since_event_id:N}` → replays delta via `event_id > N`, terminates with `sync_complete`. `{type:"history", conversation_id, before_event_id, limit}` → paginated scroll-back via `history` frame. Time-based `last_read_at` kept as fallback for pre-migration rows + UI "last seen" hint. **Kafka is still a future enhancement** — the Postgres sequence + trigger already delivers the same resilience guarantee (globally-monotonic event_id; gap-free replay for any disconnect window) without the operational burden.
