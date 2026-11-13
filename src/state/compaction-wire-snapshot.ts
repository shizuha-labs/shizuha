/**
 * CTX-5382: cache-aligned compaction for prefix-cached remote providers (Grok).
 *
 * Legacy compaction sends a DIFFERENT request shape (compactor system prompt +
 * the history flattened into one text block), so on xAI/Grok — whose prompt
 * cache is a strict token-prefix cache — the whole 150-300k context is billed
 * as fresh input on every compaction (measured 2026-11-13: 5 compaction calls,
 * ~285k uncached each, cached=1152). The agent's previous turn already wrote
 * that exact prefix to the provider cache, so a summary request that re-sends
 * the SAME system prompt + tools + wire messages and only APPENDS the compaction
 * instruction as a final user message is served almost entirely from cache.
 *
 * This module keeps the last wire request per provider instance (no I/O, no
 * secrets: it only holds references the turn already built) and decides whether
 * a compaction may safely reuse it: same model, recent enough for the provider
 * cache, and every message being summarized is covered verbatim by that request.
 * Anything else falls back to the legacy request — correctness never depends on
 * the snapshot.
 */
import type { Message } from '../agent/types.js';
import { modelConversationMessages } from '../agent/message-provenance.js';
import type { ChatMessage, ChatOptions, LLMProvider } from '../provider/types.js';

export interface WireRequestSnapshot {
  model: string;
  systemPrompt: string;
  tools: ChatOptions['tools'];
  /** Exact ChatMessage[] the turn sent to provider.chat. */
  chatMessages: ChatMessage[];
  /** Internal messages that produced chatMessages (shallow copy of refs). */
  sourceMessages: Message[];
  /** Session id the turn forwarded (x-grok-conv-id / prompt_cache_key / user). */
  sessionId?: string;
  at: number;
}

const snapshots = new WeakMap<object, WireRequestSnapshot>();

/** xAI prompt cache measured TTL: hits at <=15 min idle, always cold beyond. */
export const DEFAULT_CACHE_ALIGNED_MAX_AGE_MS = 14 * 60_000;

export type CacheAlignedMode = 'auto' | 'on' | 'off';

export function cacheAlignedCompactionMode(env: NodeJS.ProcessEnv = process.env): CacheAlignedMode {
  const raw = (env['SHIZUHA_COMPACTION_CACHE_ALIGNED'] ?? '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(raw)) return 'off';
  if (['1', 'on', 'true', 'yes', 'all'].includes(raw)) return 'on';
  return 'auto';
}

/** auto = Grok models on the xAI direct or Cortex providers (token-prefix cache,
 *  billed per uncached token against subscription credits). */
export function cacheAlignedCompactionEligible(
  providerName: string | undefined,
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = cacheAlignedCompactionMode(env);
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return /(^|[/:])grok-/i.test(model ?? '') && ['xai', 'cortex'].includes(providerName ?? '');
}

export function recordWireRequest(provider: LLMProvider, snapshot: WireRequestSnapshot): void {
  if (!cacheAlignedCompactionEligible(provider.name, snapshot.model)) return;
  snapshots.set(provider, snapshot);
}

export function lastWireRequest(provider: LLMProvider | null | undefined): WireRequestSnapshot | undefined {
  return provider ? snapshots.get(provider) : undefined;
}

export function clearWireRequest(provider: LLMProvider): void {
  snapshots.delete(provider);
}

function sameMessage(a: Message | undefined, b: Message | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Return the snapshot iff the compaction of messages[0:prefixEnd] can be served
 * by re-sending it: same model, fresh enough, and every summarized message is
 * the same (by identity or value) as the message the last request was built from.
 */
export function selectCacheAlignedSource(
  provider: LLMProvider | null | undefined,
  model: string,
  messages: Message[],
  prefixEnd: number,
  nowMs: number = Date.now(),
  maxAgeMs: number = DEFAULT_CACHE_ALIGNED_MAX_AGE_MS,
): WireRequestSnapshot | null {
  if (!provider || !cacheAlignedCompactionEligible(provider.name, model)) return null;
  const snapshot = snapshots.get(provider);
  if (!snapshot || snapshot.model !== model) return null;
  if (nowMs - snapshot.at > maxAgeMs) return null;
  if (snapshot.chatMessages.length === 0 || prefixEnd <= 0) return null;
  const covered = modelConversationMessages(snapshot.sourceMessages);
  if (prefixEnd > covered.length) return null;
  for (let index = 0; index < prefixEnd; index++) {
    if (!sameMessage(messages[index], covered[index])) return null;
  }
  return snapshot;
}
