import type { ContentBlock, Message } from '../agent/types.js';

export interface SyncHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

function extractTextContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function isoTimestamp(message: Message): string {
  return new Date(message.timestamp ?? Date.now()).toISOString();
}

function makeSyntheticId(role: 'user' | 'assistant', index: number): string {
  return `sync-${role}-${index}`;
}

export function buildSyncHistoryMessages(messages: readonly Message[]): SyncHistoryMessage[] {
  const history: SyncHistoryMessage[] = [];
  let syntheticIndex = 0;

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    const text = extractTextContent(message.content);
    if (!text.trim()) continue;

    const role = message.role;
    const id = role === 'assistant'
      ? message.id ?? message.executionId ?? makeSyntheticId(role, syntheticIndex++)
      : message.id ?? makeSyntheticId(role, syntheticIndex++);

    const existingAssistant = role === 'assistant'
      ? history.find((entry) => entry.role === 'assistant' && entry.id === id)
      : null;
    if (existingAssistant) {
      existingAssistant.content = existingAssistant.content ? `${existingAssistant.content}\n\n${text}` : text;
      continue;
    }

    history.push({
      id,
      role,
      content: text,
      created_at: isoTimestamp(message),
    });
  }

  return history;
}
