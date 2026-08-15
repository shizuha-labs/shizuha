# Messaging — Kafka / Event-Log Replay (Pending)

This document captures the remaining server-side resilience work to take Connect
from WhatsApp-parity (where we are today) to **WhatsApp-plus** — sub-second
cursor-based replay regardless of how long a client was offline. All
client-side work (dashboard, Kotlin, ori-expo) is already WhatsApp-grade; see
`MESSAGING_PROTOCOL.md` § Resilience Contract for the current compliance
matrix. This doc is scoped to what the **platform side** (`shizuha-connect`,
`shizuha-id`, nginx, Kafka) still needs.

## Why this matters

Today's `missed_message` replay on WS (re)connect is **time-based**: server
queries `DirectMessage.objects.filter(created_at__gt = participant.last_read_at,
..., sender_id__ne = user_id).order_by('created_at')[:500]` and pushes each
row. This works for every common case:

- Page refresh → last_read_at is current → empty replay window → client uses
  its local cache and REST first-load sync (per Contract item 7).
- Brief network flap → small replay window, all caught up.
- Cross-device: other device marks messages read → last_read_at advances → when
  this device reconnects it doesn't re-see those messages.

It **fails** when a client is offline for longer than the 30-min fallback
cutoff without having previously marked read — or when the server wants to
guarantee "no message ever dropped regardless of disconnect duration". Per
MESSAGING_PROTOCOL.md the fallback in that scenario is the REST emergency
recovery path, which is a one-shot full-page refetch, not an efficient delta.

WhatsApp solves this with a **per-user offset cursor** into an append-only
event log. On reconnect, client says "I last saw event N; give me everything
after N". Server streams forward from N. This is what Kafka (or any other
append-only log) gives us for free.

## Current infrastructure audit (2026-04-19)

- ❌ No Kafka in `shizuha-connect` — confirmed via grep (`kafka`, `KafkaProducer`,
  `KafkaConsumer`, `bootstrap_servers` — zero matches).
- ❌ No `event_log` / `EventLog` / `message_events` table in the Connect schema.
  `DirectMessage` is the only persisted artifact; ordering is enforced via
  `created_at` (microsecond precision).
- ❌ No monotonic `seq_num` column on `DirectMessage` — only per-model
  ordering via `Meta.ordering`.
- ✅ Redis channel layer handles real-time multicast to connected WS consumers
  but is NOT persistent — messages a consumer misses while offline never reach
  it from Redis alone.
- ✅ `ConversationParticipant.last_read_at` exists and advances on every
  `message_read` WS event (which all three clients now send).

Hritik confirmed Kafka is available in the broader platform stack; it's just
not wired into Connect yet.

## Target architecture

```
                       ┌────────────────────────────────┐
                       │      shizuha-connect           │
                       │                                │
  Client WS ──send_message─┐                            │
                           ▼                            │
                       DirectMessage (Postgres)         │
                           │                            │
                           │ on save signal             │
                           ▼                            │
                       Kafka producer ── "chat-events"  │
                           │                            │
                           │                            │
                       Kafka broker  ←─── Kafka consumer group
                           │                            │  (one per WS process)
                           ▼                            │
                       UserChatConsumer                 │
                           │                            │
                       on WS connect:                   │
                         client sends cursor = N        │
                         server: kafka.seek(offset=N+1) │
                         stream forward                 │
                       live: forward each new event     │
                             as it's committed          │
                                                        │
                       ────────────────────────────────┘
```

## Schema additions

### `DirectMessage`

- Add `event_id BIGSERIAL UNIQUE` column — monotonic, globally-ordered counter
  across all conversations. Assigned on insert. This IS the Kafka offset
  (conceptually; actual Kafka offset is internal, we expose this to clients as
  the opaque cursor).
- Add `conversation_seq_num INTEGER` — strictly monotonic PER-conversation.
  Computed via `COALESCE(MAX(conversation_seq_num), 0) + 1` in the same txn
  as the insert. Gives clients a stable ordering key independent of clock
  skew. Populates `seqNum` in the payload shape all clients already parse.

### `ConversationParticipant`

- Add `last_read_event_id BIGINT` — index into the event_id space. Advances on
  `message_read` WS events. Supersedes `last_read_at` for reconnect-delta
  queries (keep `last_read_at` for UI "last seen" display).

## New WS contract

### Client → Server (on WS open)

```json
{"type": "sync", "since_event_id": 98432172}
```

`since_event_id` is the last event_id the client has locally. Client stores
this after every ingested `new_message` / `missed_message`. On first-ever
connect, omit the field — server falls back to `last_read_event_id`, or
30-min time-based window if that's null too.

### Server → Client

- Same shapes as today (`new_message`, `missed_message`), with the existing
  payload plus `event_id`. No client-side rendering change needed — dashboard
  / Kotlin / ori-expo all already ignore unknown fields.
- After `sync`, server emits a `sync_complete` frame once the replay delta has
  drained so clients know when they're caught up. Optional for UX ("catching
  up…" indicator).

### `history` WS event (scroll-back pagination)

Independent of the Kafka work but lands naturally alongside it:

```json
{"type": "history", "conversation_id": "...", "before_event_id": 98432100, "limit": 50}
```

Server replies with 50 events strictly before that id. Removes the last REST
path from routine UX.

## Implementation phases

### Phase K1 — schema + event_id (no Kafka yet)

- Migration: add `event_id BIGSERIAL UNIQUE` + `conversation_seq_num INTEGER`
  to `DirectMessage`, and `last_read_event_id BIGINT` to
  `ConversationParticipant`. Backfill existing rows.
- Adjust `DirectMessage.save()` to set `conversation_seq_num` atomically.
- `message_read` WS handler advances `last_read_event_id` alongside
  `last_read_at`.
- Unlocks: `seqNum` field in every `new_message` / `missed_message` payload.
  Clients already parse it via the ordering tri-key — no client change needed.

### Phase K2 — Kafka producer

- Add `KAFKA_BROKERS` to `shizuha-connect` env (reuse the platform's Kafka).
- On every `DirectMessage` insert (signal or explicit produce call), emit
  `{topic: "chat-events", key: str(conversation_id), value: serialize(message)}`.
- Topic partitioning key = conversation_id so events for the same conversation
  land in the same partition → strict ordering preserved per conversation.
- Retention: 7 days (operator-configurable). Anything older falls back to the
  DirectMessage table via `GET /connect/api/conversations/:id/messages/` —
  same emergency-recovery path as today.

### Phase K3 — Kafka consumer + WS replay

- Each `UserChatConsumer` instance joins a Kafka consumer group keyed by
  `user_id`.
- On `sync` from client: `kafka.seek(offset=since_event_id + 1)` on every
  partition relevant to the user's conversations, stream forward until
  `highWatermark`, emit each as `missed_message`, then emit `sync_complete`.
- Live path: the same consumer stays subscribed and forwards new events as
  they commit.

### Phase K4 — client wiring

No client code changes to function — clients already send `sync` on WS open
today (the daemon's sync handler emits a stub event_replay). The enhancement:

- Client persists `since_event_id` (the highest `event_id` it has ingested).
- Client sends `{type: "sync", since_event_id}` on every WS open.

Per-client storage:
- Dashboard: localStorage `shizuha_connect_cursor_v1`
- Kotlin: SharedPreferences or Room `meta` row
- ori-expo: AsyncStorage `connect_cursor_v1`

### Phase K5 — `history` WS event

- Add `history` case to `UserChatConsumer.receive`.
- Query: `DirectMessage.objects.filter(conversation_id=..., event_id__lt=before_event_id).order_by('-event_id')[:limit]`.
- Emit each as `missed_message`.
- Replace REST scroll-back calls in dashboard / Kotlin / ori-expo with this
  WS event. Last REST path for routine UX goes away.

## Non-goals (explicit)

- E2E encryption — orthogonal, tracked separately.
- Media attachment replay semantics — Kafka carries only message metadata;
  media bytes live in S3 / equivalent with their own retention.
- Consolidating `UserChatConsumer` + `AgentChatConsumer` — a separate
  cleanup, doesn't block Kafka.

## Rollout plan

1. Land K1 behind a feature flag. Clients keep using time-based replay until
  the flag is on. Verify migration is clean in staging.
2. Land K2. Producer runs in shadow mode for a week — events go to Kafka but
  replay still uses Postgres. Operators watch consumer-group lag metrics.
3. Land K3 behind a per-user opt-in flag. Verify parity against the Postgres
  replay path on a canary account.
4. Flip opt-in to opt-out, then remove the time-based path after 30 days of
  clean metrics.
5. Land K4+K5 client changes. These are independent and can ship per-client
  as their respective release trains allow (dashboard → Kotlin → ori-expo).

## Observability

- Gauge: `connect.kafka.consumer.lag` per consumer group.
- Counter: `connect.replay.events_sent` tagged by `{path: kafka | postgres}`.
- Histogram: `connect.sync.duration_ms` from client `sync` to `sync_complete`.
- Counter: `connect.replay.fallback_to_rest` — should trend toward zero post-rollout.

## What I need from the platform team

1. A Kafka topic `chat-events` with ~7-day retention and as many partitions
   as we expect concurrent conversations (rough: 64 is fine for now, can scale
   via repartition later).
2. Read+write credentials for `shizuha-connect`, stored in its env via the
   existing secret pipeline.
3. An agreement on retention semantics — above the 7-day cutoff, we rely on
   the DirectMessage table via REST, same as today's emergency recovery path.

## Expected end-state

Every client, regardless of how long it was offline, does a sub-second
cursor-based replay on reconnect. REST is used only on first-ever install
(no cursor yet) and for the >7-day cache-loss scenario. `last_read_at`
becomes a UI hint ("last seen 3h ago") rather than a delivery-correctness
primitive. Missed messages become impossible for any online user.
