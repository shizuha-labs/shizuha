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
  const ts = msg._ts;
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    return new Date(ts).toISOString();
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

export function upsertAssistantMessage(
  prev: ChatMessage[],
  assistantMsg: ChatMessage,
  isReplay: boolean,
): ChatMessage[] {
  const sameIdIdx = prev.findIndex((m) => m.id === assistantMsg.id);
  if (sameIdIdx >= 0) {
    const updated = [...prev];
    updated[sameIdIdx] = assistantMsg;
    return updated;
  }

  if (!isReplay && assistantMsg.content && isClientOnlyMessageId(assistantMsg.id)) {
    const now = Date.now();
    if (prev.some((m) =>
      m.role === 'assistant' && m.content === assistantMsg.content &&
      Math.abs(new Date(m.createdAt).getTime() - now) < 5000,
    )) {
      return prev;
    }
  }

  return [...prev, assistantMsg];
}
