import { getBackendUrl } from './backend';
import type { ChatMessage } from './types';

export function realtimeVoiceUrl(agentUsername: string): string {
  const base = getBackendUrl() || (typeof window === 'undefined' ? '' : window.location.origin);
  const scheme = base.startsWith('https') ? 'wss:' : 'ws:';
  const host = base.replace(/^https?:\/\//, '');
  const agent = encodeURIComponent(agentUsername);
  return `${scheme}//${host}/v1/voice/realtime?agent=${agent}`;
}

export function historyItems(messages: ChatMessage[] | undefined, limit = 12) {
  return (messages ?? [])
    .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
    .slice(-limit)
    .map((msg) => ({
      role: msg.role,
      text: String(msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    }))
    .filter((row) => row.text);
}
