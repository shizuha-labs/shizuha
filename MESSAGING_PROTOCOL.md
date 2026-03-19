# Messaging Protocol

This document describes the messaging and chat protocol currently used across Shizuha:

- dashboard browser clients
- Kotlin/Android clients
- direct local runtimes
- the daemon on `:8015`
- agent runtime gateways on per-agent ports
- the platform runner connection

It is written from the code as it exists today. Where the system still has protocol forks, they are called out explicitly in `TODO` sections instead of being hidden.

## Goals

The protocol is designed around a few non-negotiable properties:

- one long-lived WebSocket per client, not one request per turn
- streaming assistant output as incremental events
- durable replay after reconnect
- stable message identity, not content-based dedup
- agent routing by `agent_id`
- the same mental model across browser, Kotlin, daemon, and runtime

## Core Terms

These fields appear across multiple transports and should be treated as canonical:

- `agent_id`: stable UUID for an agent
- `session_id`: backend conversation/session identifier; local runtimes usually use one eternal session
- `execution_id`: one assistant execution/turn; groups `session_start`, `content`, `tool_*`, `complete`, `error`
- `message_id`: stable identifier for a chat bubble when the server provides one
- `request_id`: client-generated identifier for a user send; used to deduplicate local echo vs server fan-out/replay
- `_seq`: append-only per-agent event-log sequence assigned by the daemon event log
- `_ts`: event-log timestamp in epoch milliseconds

Identity priority for assistant turns should be:

1. `message_id`
2. `execution_id`

Identity priority for user turns should be:

1. `request_id`
2. `message_id`

Client rule for user sends:

- browser and Kotlin should generate one stable non-UUID `request_id` per user send
- that same `request_id` should be used as the local optimistic message ID
- retries of the same local send must reuse the same `request_id`
- client-generated `request_id` values are not valid sync cursors; only server-assigned UUIDs are

## Transport Matrix

| Client | Endpoint | Primary use | Auth | Replay model |
|---|---|---|---|---|
| Browser dashboard | `ws://host:8015/ws/chat` | Main dashboard chat | dashboard session cookie or device token | daemon `event_replay` with `_seq` cursor |
| Daemon chat clients | `ws://host:8015/ws/chat/` | Same daemon chat protocol with trailing-slash variant | same as above | same as above |
| Kotlin -> direct local runtime | `ws://host:PORT/ws/chat/` | Direct runtime chat | device token or localhost bypass | `sync_history` snapshot/delta style |
| Kotlin -> SaaS platform | `wss://host/agent/ws/chat/` | Platform chat | JWT token in query string | synthesized `event_replay` over persisted platform chat history |
| Browser fallback | `POST /v1/query/stream` | No selected agent / TUI-style streaming | local/device auth | no cursor replay; plain SSE stream |
| Runtime -> platform | `ws(s)://host/ws/runner/?token=...` | Agent runner uplink | runner token + explicit `auth` frame | platform-side replay/event log semantics |

## Canonical Chat Lifecycle

The intended lifecycle of one user turn is:

1. client sends `message`
2. daemon may reply early with `relay_ack`
3. runtime may optionally reply with `message_ack`
4. server emits durable `user_message`
5. server emits `session_start`
6. server emits zero or more `reasoning`, `tool_start`, `tool_complete`, `content`
7. server emits boundary `complete` or `error`

For replay and recovery, only `complete` and `error` are boundary events. Browser committed cursors advance only on those boundaries.

Important durability rule:

- `user_message` must not be appended to the daemon event log until the daemon has successfully written the turn to the upstream runtime socket
- a failed send or failed connect must not create a durable `user_message`
- HTTP wrappers such as `/v1/agents/:id/ask` must follow the same commit boundary as WebSocket chat

## Standard Event Vocabulary

These are the important chat event types in the current system:

- `message`
- `relay_ack`
- `message_ack`
- `sync`
- `sync_history`
- `event_replay`
- `session_start`
- `content`
- `reasoning`
- `tool_start`
- `tool_complete`
- `complete`
- `error`
- `user_message`
- `proactive_message`
- `transport_status`
- `agent_status`
- `ping`
- `pong`

Dashboard-only control messages on the same socket:

- `rpc`
- `rpc_response`
- `subscribe`
- `subscribed`
- `agents_snapshot`
- `agent_updated`
- `status_update`
- `auth_required`
- `auth_device_code`
- `auth_complete`
- `auth_error`

Status semantics are now explicit:

- `transport_status`: transport-wide daemon/platform connectivity for the current websocket
- `agent_status`: runtime connection state for one `agent_id`

Clients must not treat `agent_status` as the global dashboard WebSocket indicator.

Ack semantics:

- `relay_ack`: emitted by the daemon when it has successfully written the user message onto the local runtime socket
- `message_ack`: emitted by a runtime bridge when it has accepted the turn; it may also include richer runtime metadata such as `session_id` or `queued`
- `busy`: informational queue-state notice from gateway-style runtimes; it means the turn is queued behind an in-flight execution, not that the send failed

Client rule:

- the first `relay_ack` or `message_ack` means the send has been accepted
- clients must not wait only for `message_ack`, because gateway-style agents may emit only `relay_ack`
- if both arrive, `message_ack` is the richer runtime-level acknowledgement, but it is not required for basic send confirmation
- clients must not mark the message as undelivered or schedule a resend purely because they saw `busy`

## Unary HTTP Wrapper

The daemon also exposes:

```text
POST /v1/agents/:id/ask
```

This is a convenience wrapper for server-side callers such as inter-agent tools and cron flows. It is not a separate messaging protocol. It must obey the same transport semantics as daemon WebSocket chat:

- no durable `user_message` before upstream socket write succeeds
- failed connect/write returns an error and leaves the event log unchanged
- successful send may then fan out the durable `user_message` to other devices

## Browser Dashboard <-> Daemon `:8015`

Code:

- [`src/daemon/dashboard.ts`](./src/daemon/dashboard.ts)
- [`src/daemon/event-log.ts`](./src/daemon/event-log.ts)
- [`src/web/hooks/useChat.ts`](./src/web/hooks/useChat.ts)
- [`src/web/lib/chat-sync.ts`](./src/web/lib/chat-sync.ts)

This is the most advanced and most reliable chat path in the current codebase.

### Connection

The dashboard opens one WebSocket to:

```text
ws://host:8015/ws/chat
```

The daemon currently accepts both:

- `/ws/chat`
- `/ws/chat/`

but the browser should use `/ws/chat`.

### Authentication

The daemon upgrade handler accepts:

- dashboard session cookie (`shizuha_session`)
- paired-device bearer token in query or `Authorization`
- localhost bypass

### Send

Browser send envelope:

```json
{
  "type": "message",
  "agent_id": "00000000-0000-0000-0000-000000000001",
  "content": "What is 2+40? Just the number.",
  "request_id": "user-1710680000000-ab12cd"
}
```

The browser also sends `sync` after connect/reconnect:

```json
{
  "type": "sync",
  "agent_id": "00000000-0000-0000-0000-000000000001",
  "cursor": 137938,
  "last_message_id": "a54c..."
}
```

Meaning:

- `cursor`: session high-water mark when reconnecting inside the same page session; otherwise the last committed daemon event-log boundary sequence from localStorage
- `last_message_id`: last server message ID visible in cached local chat

Browser cursor rules:

- same-page websocket reconnect: use the in-memory `sessionCursor`
- page refresh / new tab / cold load: fall back to the persisted `committedCursor`

This distinction matters because the daemon event log is bounded. Reconnects should ask only for the tail the current page has not yet seen, while refreshes need the durable boundary checkpoint so an interrupted turn can be reconstructed from replay.

The daemon may also receive `rpc` frames for sidebar/admin actions over the same socket.

### Receive

Important daemon -> browser frames:

```json
{ "type": "relay_ack", "agent_id": "..." }
```

```json
{
  "type": "message_ack",
  "agent_id": "...",
  "data": {
    "session_id": "agent-session-...",
    "thread_id": "optional",
    "queued": false
  }
}
```

```json
{
  "type": "user_message",
  "agent_id": "...",
  "data": {
    "content": "What is 2+40? Just the number.",
    "message_id": "5c3f..."
  },
  "_seq": 137939
}
```

```json
{
  "type": "session_start",
  "agent_id": "...",
  "execution_id": "410da0d6-1289-4ca2-9510-2e84828ade19",
  "data": {
    "session_id": "agent-session-00000000-0000-0000-0000-000000000001",
    "model": "gpt-5.3-codex-spark",
    "message_id": "6e6d3d55-6f2a-47b4-9e76-3d4f8d4b8f2d"
  },
  "_seq": 137940,
  "_ts": 1773740000000
}
```

```json
{
  "type": "content",
  "execution_id": "410da0d6-1289-4ca2-9510-2e84828ade19",
  "data": { "delta": "42" },
  "_seq": 137941,
  "_ts": 1773740000100
}
```

```json
{
  "type": "complete",
  "execution_id": "410da0d6-1289-4ca2-9510-2e84828ade19",
  "data": {
    "result": {
      "total_turns": 1,
      "input_tokens": 123,
      "output_tokens": 1
    },
    "duration_seconds": 0.81
  },
  "_seq": 137942,
  "_ts": 1773740000200
}
```

### Replay

The daemon event log is SQLite-backed append-only storage:

- table: `event_log(seq, agent_id, event, ts)`
- retention: 24h
- durable types:
  - `content`
  - `tool_start`
  - `tool_complete`
  - `complete`
  - `error`
  - `session_start`
  - `user_message`
  - `proactive_message`

Replay response:

```json
{
  "type": "event_replay",
  "agent_id": "...",
  "events": [
    { "type": "user_message", "...": "...", "_seq": 137939, "_ts": 1773740000000 },
    { "type": "session_start", "...": "...", "_seq": 137940, "_ts": 1773740000010 },
    { "type": "content", "...": "...", "_seq": 137941, "_ts": 1773740000100 },
    { "type": "complete", "...": "...", "_seq": 137942, "_ts": 1773740000200 }
  ],
  "first_seq": 137939,
  "last_seq": 137942,
  "cursor": 137942
}
```

Important details:

- the daemon may coalesce many tiny `content` deltas into one larger replay `content`
- replay identity is by actual sequence range: `agent_id + first_seq + last_seq`
- the browser rebuilds message state from replay events, not by comparing content strings
- `agent_status` is not durable and is never replayed from the event log
- `reasoning` is currently **not** durable in the daemon event log, so reconnecting clients may miss already-emitted reasoning summaries from a live turn

### Ordering Guarantee

For one `agent_id`, the daemon event log provides a strict append order:

- replay is returned in ascending `_seq`
- live events are forwarded to each subscribed browser client in the same order the daemon processes them
- if a live event is also durable, its `_seq` is assigned before fan-out, so replay and future reconnects observe the same ordering

What this does not guarantee:

- no global ordering across different agents
- no stronger causal ordering across different event sources beyond daemon arrival and append order
  - for example, a proactive event and a runtime event for the same agent are ordered by when the daemon receives them

### Browser Cursor Model

The browser uses two cursors:

- committed cursor in `localStorage`
- in-memory session cursor

Rules:

- session cursor advances on every event seen in the current page session
- committed cursor advances only on `complete` or `error`
- on reconnect without refresh, session cursor prevents reprocessing duplicate events
- on page refresh, committed cursor causes replay from the last completed boundary

This is the current canonical replay model.

### Keepalive

The browser/daemon path currently supports:

- application-level `ping` -> `pong`
- normal WebSocket close and reconnect behavior

Current implementation details:

- the daemon sends application-level `ping` every 25 seconds on `/ws/chat`
- browser and Kotlin clients reply with application-level `pong`
- the daemon closes a `/ws/chat` client after 60 seconds without client heartbeat activity (`ping` or `pong`)
- the daemon still replies to client-originated `ping` with `pong`
- Kotlin also actively sends periodic application `ping`
- the browser currently relies on daemon-originated `ping` and does not originate its own periodic app-level `ping`

Separate from that, direct local-runtime and bridge sockets use transport-level WebSocket ping frames internally.

## Kotlin Client <-> Direct Local Runtime `/ws/chat/`

Code:

- [`kotlin/app/src/main/java/com/shizuha/assistant/data/ServerConfigImpl.kt`](../kotlin/app/src/main/java/com/shizuha/assistant/data/ServerConfigImpl.kt)
- [`kotlin/shared/src/main/java/com/shizuha/shared/api/WebSocketClient.kt`](../kotlin/shared/src/main/java/com/shizuha/shared/api/WebSocketClient.kt)
- [`kotlin/shared/src/main/java/com/shizuha/shared/model/ChatModels.kt`](../kotlin/shared/src/main/java/com/shizuha/shared/model/ChatModels.kt)
- [`src/gateway/channels/http.ts`](./src/gateway/channels/http.ts)

When Kotlin is in local-runtime mode it connects directly to:

```text
ws://host:PORT/ws/chat/
```

Examples:

- embedded on-device agent: `ws://127.0.0.1:${actualPort}/ws/chat/`
- LAN runtime: `ws://192.168.29.84:8015/ws/chat/`

### Send

Kotlin uses the agent-routed send:

```json
{
  "type": "message",
  "agent_id": "...",
  "content": "Hello",
  "request_id": "user-1710680000000-ab12cd",
  "source_service": "android",
  "user_name": "phoenix",
  "user_id": "phoenix"
}
```

Sync request:

```json
{
  "type": "sync",
  "agent_id": "...",
  "last_message_id": "uuid",
  "cursor": 137942,
  "stream_acks": {
    "execution-id": "1710679999123-14"
  }
}
```

Notes:

- `last_message_id` is the main direct-runtime sync primitive today
- `cursor` is optional and currently only becomes meaningful when the client has already talked to a daemon bridge that supports `event_replay`
- `stream_acks` exist in the Kotlin client model, but direct local runtime does not currently implement them

### Receive

The direct runtime currently returns:

- `session_start`
- `content`
- `reasoning`
- `tool_start`
- `tool_complete`
- `complete`
- `error`
- `sync_history`
- `user_message`
- `proactive_message`

Example `sync_history`:

```json
{
  "type": "sync_history",
  "session_id": "agent-session-...",
  "messages": [
    {
      "id": "msg-0",
      "role": "user",
      "content": "Hello",
      "timestamp": 1773740000000
    },
    {
      "id": "msg-1",
      "role": "assistant",
      "content": "Hi",
      "timestamp": 1773740001000
    }
  ]
}
```

### Kotlin Merge Model

Kotlin persists messages in Room and merges server data in three phases:

1. reconcile ID mismatches
2. repair canonical content/timestamps/streaming state
3. insert genuinely new messages

Important behavior:

- Kotlin already prefers stable IDs over content-only dedup
- if it receives daemon `event_replay`, it converts it into synthetic `sync_history`
- for assistant turns, it prefers `session_start.data.message_id`; otherwise it falls back to `execution_id`

## Kotlin Client <-> SaaS Platform `/agent/ws/chat/`

Code:

- [`kotlin/app/src/main/java/com/shizuha/assistant/data/ServerConfigImpl.kt`](../kotlin/app/src/main/java/com/shizuha/assistant/data/ServerConfigImpl.kt)
- [`kotlin/shared/src/main/java/com/shizuha/shared/api/WebSocketClient.kt`](../kotlin/shared/src/main/java/com/shizuha/shared/api/WebSocketClient.kt)

When Kotlin is not in local-runtime mode it connects to:

```text
wss://host/agent/ws/chat/?token=<jwt>
```

This path used to be more obviously legacy. It now speaks much more of the same vocabulary as the daemon browser path, and it does have a real execution-event stream for live runs via Kafka. The main gap is narrower: historical `sync` / `event_replay` is still reconstructed from persisted chat messages instead of replaying a durable append-only history of the original stream events.

Current differences:

- auth is platform JWT, not device token / dashboard session
- live execution streaming goes through Kafka, keyed by `execution_id`
- replay is emitted as `event_replay`, but synthesized from stored `ChatbotMessage` rows
- platform supports `stream_ack`, `streaming_recovery`, and `cancel`
- `_seq` values are synthetic cursor numbers derived from message timestamps, not durable event-log sequence IDs
- platform materializes streamed execution state into `ChatbotMessage` rows and reconstructs a minimal turn transcript on sync

## Daemon <-> Local Agent Runtime

Code:

- [`src/daemon/dashboard.ts`](./src/daemon/dashboard.ts)
- [`src/gateway/channels/http.ts`](./src/gateway/channels/http.ts)

The daemon bridge talks to local agent runtimes over:

```text
ws://127.0.0.1:<agent-port>/ws/chat/
```

The daemon:

- sends `message` to the agent runtime
- emits `relay_ack` after writing successfully to the local runtime socket
- persists durable events into the daemon event log
- fans events out to subscribed browser clients
- mirrors user messages to the platform best-effort
- keeps exactly one upstream WebSocket per local agent runtime
- suppresses repeated identical status events per scope (`transport` or per-`agent_id`)

This is the key layering:

- browser never talks directly to a local agent process
- browser talks to daemon `/ws/chat`
- daemon talks to local runtime `/ws/chat/`
- daemon is the fanout layer; multiple dashboard/Kotlin viewers must not create parallel daemon -> runtime sockets for the same agent

### Bridge Normalization

The bridge -> daemon hop is where most protocol translation happens.

Daemon-facing bridge contract today:

- `message_ack`
- `content`
- `reasoning`
- `tool_start`
- `tool_complete`
- `complete`
- `error`
- top-level `execution_id` for streamed assistant turns

Current bridge/runtime variants:

- gateway runtime (`src/gateway/channels/http.ts`)
  - emits `session_start`, `content`, `reasoning`, `tool_*`, `complete`, `error`
  - preallocates one assistant `message_id` at execution start and reuses it for replay/history
- Codex bridge (`src/codex-bridge/index.ts`)
  - normalizes Codex stream events into the same outward shape
  - emits `session_start` with the preallocated assistant `message_id`
- Claude bridge (`src/claude-bridge/index.ts`)
  - normalizes `session_start` / `content` / `reasoning` / `tool_*` / `complete`
  - preallocates one assistant `message_id` per execution
- OpenClaw bridge (`src/openclaw-bridge/index.ts`)
  - translates internal gateway `runId/stream/data` events into daemon-facing `session_start` / `content` / `tool_*` / `complete`
  - preallocates one assistant `message_id` per execution
  - on the daemon-facing wire, `execution_id` is top-level, not nested under `data`

Queue semantics:

- bridges may emit `message_ack { queued: true }` when a turn is accepted into a local bridge queue behind an active execution
- gateway-style runtimes currently rely on daemon `relay_ack` and do not emit bridge `message_ack`
- gateway-style `busy` is advisory queue telemetry only; the turn remains accepted and should stay in normal chat history on the client

### Status Semantics

Daemon-generated local runtime status frames now look like:

```json
{ "type": "agent_status", "agent_id": "local-claw-mmt756wx", "connected": true }
```

Global daemon/platform transport status remains:

```json
{ "type": "transport_status", "connected": true }
```

Rules:

- `agent_status` is routed only to subscribers of that `agent_id`
- consecutive identical status values in the same scope are suppressed
- `agent_status` is control-plane only; it is not stored in the durable event log
- a client may see one `transport_status` and one `agent_status` during initial connect; they mean different things
- a client may see both `relay_ack` and `message_ack` for the same turn; they are different layers, but either one is sufficient to treat the send as accepted

TODO

- unify `relay_ack` and `message_ack` into one staged public ack shape if we want to simplify the wire protocol later, for example `message_ack { stage: "relay" | "runtime" }`

## Browser Fallback: SSE `/v1/query/stream`

Code:

- [`src/gateway/channels/http.ts`](./src/gateway/channels/http.ts)
- [`src/web/hooks/useChat.ts`](./src/web/hooks/useChat.ts)

If no `agentId` is selected, the web UI falls back to:

```text
POST /v1/query/stream
```

Request body:

```json
{
  "prompt": "hello",
  "model": "gpt-5.3-codex-spark",
  "permissionMode": "supervised"
}
```

Response:

- `text/event-stream`
- same internal `AgentEvent` stream rendered as SSE
- no daemon event-log replay semantics

This is a useful local/TUI compatibility path, not the main multi-agent dashboard protocol.

## Proactive Delivery Semantics

`proactive_message` covers cron, heartbeat, and inter-agent initiated assistant messages.

Current guarantees:

- proactive messages are durable in the daemon event log
- if a client is connected and subscribed, it should see the live proactive event immediately
- if no client is connected, the proactive message is not lost; it appears on later replay or sync

Current non-guarantees:

- there is no separate ack for proactive delivery to an end-user client
- proactive live fan-out is effectively fire-and-forget
- the durable guarantee is replay visibility, not immediate foreground delivery

## Runtime <-> Platform Runner

Code:

- [`src/gateway/channels/shizuha-ws.ts`](./src/gateway/channels/shizuha-ws.ts)

This is the outbound runtime uplink to the platform runner endpoint.

Flow:

1. runtime connects to `/ws/runner/`
2. runtime sends:

```json
{ "type": "auth", "token": "sza_...", "runner_version": "0.1.0" }
```

3. platform sends user work as `message` / `user_message`
4. runtime streams back:
   - `stream_event`
   - `execution_complete`
   - `execution_error`

Examples:

```json
{
  "type": "stream_event",
  "session_id": "execution-id",
  "execution_id": "execution-id",
  "agent_id": "...",
  "event": { "type": "content", "data": { "delta": "hello" } }
}
```

```json
{
  "type": "execution_complete",
  "session_id": "execution-id",
  "execution_id": "execution-id",
  "agent_id": "...",
  "result": {
    "total_turns": 1,
    "input_tokens": 123,
    "output_tokens": 45,
    "duration_seconds": 1.2
  }
}
```

This path is conceptually the platform equivalent of the daemon bridge, but its wire envelope is still runner-specific.

## Replay and Dedup Rules

These are the rules we should preserve everywhere:

### 1. Never deduplicate by content alone

`"42"` can be a valid assistant reply many times.

Correct dedup inputs are:

- user: `request_id`, then `message_id`
- assistant: `message_id`, then `execution_id`
- replay batches: `agent_id + first_seq + last_seq`

### 2. Cursor is transport state, not message identity

- `_seq` says where the client is in the daemon event log
- `_seq` does not replace `message_id`

### 3. Boundary events own durable progress

Committed cursor should move only on:

- `complete`
- `error`

### 4. Replay rebuilds state

On replay:

- clients must be willing to discard stale partial streaming state
- replayed assistant content must rehydrate the same message identity

## Current Standard

If we describe one protocol as the current reference model, it is:

- daemon dashboard event-log protocol on `:8015`
- `sync` with `cursor`
- `event_replay` with `_seq`, `_ts`, `first_seq`, `last_seq`
- assistant turn identity by `message_id` or `execution_id`
- user echo dedup by `request_id`

This is the protocol we should converge the other chat paths toward.

## TODO: Remaining Forks

These are real current gaps, not aspirational notes.

### TODO: Direct runtime `/ws/chat/` still returns `sync_history`

The local runtime HTTP channel currently answers `sync` with `sync_history`, not daemon-style `event_replay`.

Impact:

- weaker replay semantics
- less explicit ordered event recovery
- no first-class `_seq` / `_ts` cursor contract

### TODO: `stream_ack` and `cancel` are placeholders on direct runtime

In [`src/gateway/channels/http.ts`](./src/gateway/channels/http.ts), both are acknowledged but not implemented.

Impact:

- Kotlin can send these frames
- local runtime does not currently honor them

### TODO: `reasoning` is live-only on the daemon event log

The daemon durable event set currently excludes `reasoning`.

Impact:

- if a user disconnects mid-turn and reconnects, already-emitted reasoning summaries are not replayed from the daemon event log
- assistant content and terminal events still recover correctly, but reasoning visibility is weaker than content visibility

### TODO: Platform `/agent/ws/chat/` uses Kafka for live execution streaming, but historical replay is still synthesized

The platform chat socket already emits daemon-style `event_replay`. Live execution events are published to Kafka and materialized into `ChatbotMessage`, but historical replay still rebuilds a turn transcript from those persisted messages instead of replaying the original event stream.

Impact:

- live streaming semantics are stronger than the old wording implied
- replay granularity is reconstructed, not original
- `_seq` is synthetic and cursor-like, not a true transport event sequence
- platform and daemon are closer semantically than operationally

Target direction:

- keep platform JWT auth
- preserve the current event vocabulary
- decide whether Kafka should become the durable replay source of truth, or whether the platform should grow a daemon-style materialized event log with stable cursor IDs

### Assistant Turn Identity

Local runtime and bridge executions now preallocate one stable assistant `message_id`
at execution start:

- runtime/bridge generates `message_id = uuid`
- `session_start.data.message_id` carries it before the first content delta
- all streamed `content` / `tool_*` / `complete` events for that execution still use `execution_id`
- durable replay/history should reuse that same `message_id` for the final assistant bubble

Clients should still keep the fallback order:

1. `message_id`
2. `execution_id`

That fallback remains necessary for:

- older servers that predate the universal `session_start.data.message_id`
- replayed/platform-originated events that may only expose `execution_id`

## Source Map

Primary implementation files:

- daemon bridge and replay: [`src/daemon/dashboard.ts`](./src/daemon/dashboard.ts)
- append-only log: [`src/daemon/event-log.ts`](./src/daemon/event-log.ts)
- direct runtime HTTP/WS channel: [`src/gateway/channels/http.ts`](./src/gateway/channels/http.ts)
- Codex bridge: [`src/codex-bridge/index.ts`](./src/codex-bridge/index.ts)
- Claude bridge: [`src/claude-bridge/index.ts`](./src/claude-bridge/index.ts)
- OpenClaw bridge: [`src/openclaw-bridge/index.ts`](./src/openclaw-bridge/index.ts)
- platform runner channel: [`src/gateway/channels/shizuha-ws.ts`](./src/gateway/channels/shizuha-ws.ts)
- browser state machine: [`src/web/hooks/useChat.ts`](./src/web/hooks/useChat.ts)
- browser replay helpers: [`src/web/lib/chat-sync.ts`](./src/web/lib/chat-sync.ts)
- Kotlin WebSocket client: [`../kotlin/shared/src/main/java/com/shizuha/shared/api/WebSocketClient.kt`](../kotlin/shared/src/main/java/com/shizuha/shared/api/WebSocketClient.kt)
- Kotlin chat models: [`../kotlin/shared/src/main/java/com/shizuha/shared/model/ChatModels.kt`](../kotlin/shared/src/main/java/com/shizuha/shared/model/ChatModels.kt)
- Kotlin repository merge logic: [`../kotlin/shared/src/main/java/com/shizuha/shared/repository/ChatRepository.kt`](../kotlin/shared/src/main/java/com/shizuha/shared/repository/ChatRepository.kt)
