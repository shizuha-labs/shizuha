import type { Message } from '../agent/types.js';

export interface InterruptCheckpoint {
  createdAt: number;
  promptExcerpt: string;
  note: string;
  /**
   * 'turn' — a user turn was interrupted or errored; replayed in the resume
   * banner with the last prompt excerpt so the user knows work may be
   * incomplete. 'maintenance' — transient lifecycle frames (compaction
   * heartbeats etc.), persisted for crash forensics only and never replayed:
   * a fresh resume re-runs and re-reports any needed maintenance itself.
   * Absent on rows written by older builds — treated as 'turn' unless the
   * note is recognizably a compaction frame.
   */
  kind?: 'turn' | 'maintenance';
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
