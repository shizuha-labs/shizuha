import type { Message } from '../agent/types.js';

export interface InterruptCheckpoint {
  createdAt: number;
  promptExcerpt: string;
  note: string;
}

export interface Session {
  id: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  interruptCheckpoint?: InterruptCheckpoint;
}

export interface ConversationState {
  sessionId: string;
  messages: Message[];
  systemPrompt: string;
  compactedAt?: number;
}
