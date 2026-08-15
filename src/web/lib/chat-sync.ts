import type { ChatMessage } from './types';

const CLIENT_ONLY_MESSAGE_ID_PREFIXES = [
  'assistant-',
  'assistant-interrupted-',
  'failed-',
  'proactive-',
  'sys-',
  'auth-',
  'auth-code-',
  'auth-done-',
  'auth-err-',
  'user-',
];

function isClientOnlyMessageId(id: string): boolean {
  return CLIENT_ONLY_MESSAGE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function resolveAssistantTurnId(msg: Record<string, unknown>): string | null {
  const data = msg.data as Record<string, unknown> | undefined;
  const messageId = typeof data?.message_id === 'string'
    ? data.message_id
    : typeof msg.message_id === 'string'
      ? msg.message_id
      : null;
  if (messageId) return messageId;
  return typeof msg.execution_id === 'string' ? msg.execution_id : null;
}

export function eventTimestampToIso(msg: Record<string, unknown>): string | null {
  // Primary: numeric `_ts` (ms since epoch) — matches the daemon event-log
  // replay contract. All bridge-emitted events should set this for history
  // items so they don't collapse to render-time.
  const ts = msg._ts;
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    return new Date(ts).toISOString();
  }
  // Fallback: ISO `timestamp` string — what the Connect bridge used to emit
  // for new_message / missed_message translations. Accepting both shapes
  // means any future emitter that only populates one field still yields a
  // correct server-authoritative createdAt, not a render-time stamp.
  const iso = msg.timestamp;
  if (typeof iso === 'string' && iso.length > 0) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed) && parsed > 0) return new Date(parsed).toISOString();
  }
  return null;
}

export function buildReplayBatchKey(msg: Record<string, unknown>): string {
  const agentId = typeof msg.agent_id === 'string' ? msg.agent_id : 'unknown-agent';
  const events = Array.isArray(msg.events) ? msg.events as Array<Record<string, unknown>> : [];
  const firstSeq = typeof msg.first_seq === 'number'
    ? msg.first_seq
    : typeof events[0]?._seq === 'number'
      ? events[0]!._seq as number
      : 0;
  const lastSeq = typeof msg.last_seq === 'number'
    ? msg.last_seq
    : typeof msg.cursor === 'number'
      ? msg.cursor
      : typeof events[events.length - 1]?._seq === 'number'
        ? events[events.length - 1]!._seq as number
        : 0;
  return `${agentId}-${firstSeq}-${lastSeq}`;
}

/**
 * Ordering key for a ChatMessage.
 * Primary: seqNum (daemon event log, monotonic per-agent).
 * Secondary: createdAt (server-assigned for persisted DMs; local clock only for
 *   `pending` optimistic sends, which sort last until the server echo replaces them).
 * Tiebreaker: id (stable).
 *
 * See MESSAGING_PROTOCOL.md § Message Ordering.
 */
function orderKey(m: ChatMessage): [number, number, string] {
  // Pending local messages sort last in their timestamp bucket so a later-arriving
  // server-echoed message with an EARLIER createdAt still lands where it belongs.
  // Once the echo replaces the pending entry, its server seqNum / createdAt apply.
  const seq = typeof m.seqNum === 'number' ? m.seqNum : Number.POSITIVE_INFINITY;
  const ts = new Date(m.createdAt).getTime();
  return [seq, Number.isFinite(ts) ? ts : 0, m.id];
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const [as, at, ai] = orderKey(a);
  const [bs, bt, bi] = orderKey(b);
  if (as !== bs) return as - bs;
  if (at !== bt) return at - bt;
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * Insert-or-replace `msg` into the ordered list `prev`.
 *
 * Replacement rules (in priority order):
 *   1. Same `id` → update in place.
 *   2. `msg` is a server-stamped version of a pending local entry — match by
 *      `(role, content, pending:true)` and adopt server id/seqNum/createdAt.
 *   3. Content-dedup for client-only assistant messages replayed within 5s
 *      (prevents duplicate bubbles from replay + live event races).
 *   4. Otherwise, binary-insert by (seqNum, createdAt, id).
 */
export function insertOrdered(
  prev: ChatMessage[],
  msg: ChatMessage,
  opts: { isReplay?: boolean; isServerEcho?: boolean } = {},
): ChatMessage[] {
  // (0) Client-message-id match — WhatsApp-style primary dedup. The CMID is
  // the client-generated UUID that Connect persists via
  // `DirectMessage.client_message_id` (UNIQUE per conversation) and echoes
  // back unchanged in `new_message` / `missed_message`. When present on
  // BOTH sides we have a deterministic match — no content/role/pending
  // heuristics needed. Used for:
  //   • replacing the sender's optimistic entry with the server-echoed one
  //     (the server `id` differs from the local `id` which was set to the
  //     CMID for optimistic display).
  //   • deduplicating repeated deliveries of the same persisted message
  //     (live echo + missed_message replay + REST first-load sync all
  //     carry the same CMID).
  if (msg.clientMessageId) {
    const cmidIdx = prev.findIndex((m) => m.clientMessageId === msg.clientMessageId);
    if (cmidIdx >= 0) {
      const existing = prev[cmidIdx]!;
      // Preserve the existing id if it's already the server UUID (avoids
      // downgrading to a second copy's CMID). Adopt server-authoritative
      // fields (createdAt, seqNum) from msg.
      const merged: ChatMessage = {
        ...existing,
        ...msg,
        // Prefer the server-assigned id when present.
        id: msg.id ?? existing.id,
        pending: false,
      };
      const updated = [...prev];
      updated[cmidIdx] = merged;
      updated.sort(compareMessages);
      return updated;
    }
  }

  // (1) Same id — update in place. If the server-assigned seqNum/createdAt
  // now reorders relative to neighbours (pending→server echo replacement),
  // re-sort the array so the entry lands in its correct slot.
  const sameIdIdx = prev.findIndex((m) => m.id === msg.id);
  if (sameIdIdx >= 0) {
    const merged = { ...prev[sameIdIdx]!, ...msg };
    const updated = [...prev];
    updated[sameIdIdx] = merged;
    const left = sameIdIdx > 0 ? updated[sameIdIdx - 1] : null;
    const right = sameIdIdx + 1 < updated.length ? updated[sameIdIdx + 1] : null;
    const outOfOrder =
      (left && compareMessages(left, merged) > 0) ||
      (right && compareMessages(merged, right) > 0);
    if (outOfOrder) {
      updated.sort(compareMessages);
    }
    return updated;
  }

  // (2) Server echo replacing a pending local send — fallback when CMID
  // isn't carried end-to-end (older code paths, cross-device broadcasts
  // without CMID). Match by role + content where the existing entry is
  // still pending. Rule (0) above supersedes this when both sides have CMID.
  if (opts.isServerEcho && msg.role === 'user') {
    const pendingIdx = prev.findIndex(
      (m) => m.pending && m.role === 'user' && m.content === msg.content,
    );
    if (pendingIdx >= 0) {
      const updated = [...prev];
      updated[pendingIdx] = { ...msg, pending: false };
      // Server createdAt may differ from the local one — resort.
      updated.sort(compareMessages);
      return updated;
    }
  }

  // (3) Content-based dedup for assistant messages with client-only IDs during
  // live event / replay races.
  if (!opts.isReplay && msg.content && isClientOnlyMessageId(msg.id) && msg.role === 'assistant') {
    const now = Date.now();
    if (prev.some((m) =>
      m.role === 'assistant' && m.content === msg.content &&
      Math.abs(new Date(m.createdAt).getTime() - now) < 5000,
    )) {
      return prev;
    }
  }

  // (4) Binary insert by ordering key.
  const result = [...prev];
  let lo = 0;
  let hi = result.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareMessages(result[mid]!, msg) < 0) lo = mid + 1;
    else hi = mid;
  }
  result.splice(lo, 0, msg);
  return result;
}

/**
 * @deprecated Use `insertOrdered(prev, msg, { isReplay })` directly.
 * Kept as an alias so existing call sites keep compiling during the migration.
 */
export function upsertAssistantMessage(
  prev: ChatMessage[],
  assistantMsg: ChatMessage,
  isReplay: boolean,
): ChatMessage[] {
  return insertOrdered(prev, assistantMsg, { isReplay });
}
