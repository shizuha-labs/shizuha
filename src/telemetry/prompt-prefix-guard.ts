/**
 * PLAT-4189 follow-up (2026-07-12): byte-level prompt-prefix continuity guard
 * for the provider request path.
 *
 * The vLLM/Cortex prefix cache only reuses KV blocks for EXACT prefix
 * extensions. Any byte that changes BEFORE the append point forces a full
 * re-prefill of the whole 50-130k-token session (measured 20-84s TTFT
 * fleet-wide, wiki 5d8032ae). The server-side `cache_miss_detector` can only
 * infer `prefix_mutation` from (same backend, similar size, still cold) — it
 * cannot see WHICH bytes moved, and it cannot distinguish a client-side prefix
 * rewrite from server-side KV-block eviction under memory pressure.
 *
 * This guard closes that gap at the byte source. On every provider request it
 * builds a canonical serialization of the payload (model + tools + each
 * message, joined with a record separator), splits it into fixed-size chunks,
 * hashes each complete chunk, and compares against the previous request of the
 * same session:
 *
 *  - append-only  → every previous complete-chunk hash matches AND the
 *                   previous residual tail is a literal prefix of the new
 *                   content at the same offset. (Fixed chunk boundaries are
 *                   measured from offset 0, so appending text never changes an
 *                   earlier chunk.)
 *  - divergent    → anything else. The observation reports the first divergent
 *                   chunk, the char offset, and which payload part (model /
 *                   tools / system / message[i]) owns those bytes — the exact
 *                   pinpointing the server-side detector cannot do.
 *
 * A `divergent` observation on a request the server also flags as
 * `prefix_mutation` proves a CLIENT-side rewrite; `append` + still-cold proves
 * server-side eviction/capacity. Expected divergences are compaction / trim
 * turns only (rare by design); everything else must be append-only.
 *
 * Fail-open by design: callers wrap observe() in try/catch, state is bounded
 * (LRU sessions, residual capped at one chunk), and the guard never touches
 * the request itself. Disable with SHIZUHA_PROMPT_PREFIX_GUARD=0.
 */

import { createHash } from 'node:crypto';

/** Record separator between payload parts — prevents boundary ambiguity
 *  (e.g. moving bytes between adjacent messages without changing the concat). */
const PART_SEPARATOR = '\u001e';

/** Default chunk size in chars (~4k tokens at 4 chars/token). */
const DEFAULT_CHUNK_CHARS = 16_384;

/** Default max tracked sessions (gateway = 1 agent; TUI may run a few). */
const DEFAULT_MAX_SESSIONS = 16;

export interface PromptPrefixPart {
  /** Human-readable label, e.g. "message[12] role=assistant". */
  label: string;
  /** Bounded-cardinality class for metrics: model|tools|system|message|unknown. */
  partClass: 'model' | 'tools' | 'system' | 'message' | 'unknown';
  content: string;
}

export type PromptPrefixStatus = 'first' | 'identical' | 'append' | 'divergent';

export interface PromptPrefixObservation {
  status: PromptPrefixStatus;
  totalChars: number;
  chunkCount: number;
  prevTotalChars?: number;
  prevChunkCount?: number;
  /** Index of the first complete chunk whose hash diverged (or the previous
   *  chunk count when the divergence sits in the previous residual tail). */
  firstDivergentChunk?: number;
  /** Char offset (into the canonical serialization) where divergence begins. */
  divergentCharOffset?: number;
  /** Label of the CURRENT payload part owning the divergent offset. */
  divergentPart?: string;
  /** Bounded-cardinality part class for metrics ('truncation' = payload shrank
   *  past the divergent offset). */
  divergentPartClass?: string;
}

interface SessionFingerprint {
  chunkHashes: string[];
  /** Raw residual tail after the last complete chunk (≤ chunkChars chars). */
  residual: string;
  totalChars: number;
  /** Per-part hashes for exact divergence attribution (labels + 16-hex hashes). */
  partHashes: Array<{ label: string; partClass: PromptPrefixPart['partClass']; hash: string }>;
}

function chunkHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function promptPrefixGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env['SHIZUHA_PROMPT_PREFIX_GUARD'] ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

export class PromptPrefixGuard {
  private sessions = new Map<string, SessionFingerprint>();

  constructor(
    private readonly chunkChars = DEFAULT_CHUNK_CHARS,
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
  ) {}

  /** Observe one request payload for a session; returns the continuity verdict. */
  observe(sessionKey: string, parts: PromptPrefixPart[]): PromptPrefixObservation {
    const canonical = parts.map((p) => p.content).join(PART_SEPARATOR);
    const totalChars = canonical.length;
    const completeChunks = Math.floor(totalChars / this.chunkChars);
    const chunkHashes: string[] = [];
    for (let i = 0; i < completeChunks; i++) {
      chunkHashes.push(chunkHash(canonical.slice(i * this.chunkChars, (i + 1) * this.chunkChars)));
    }
    const residual = canonical.slice(completeChunks * this.chunkChars);
    const partHashes = parts.map((p) => ({ label: p.label, partClass: p.partClass, hash: chunkHash(p.content) }));

    const previous = this.sessions.get(sessionKey);
    this.remember(sessionKey, { chunkHashes, residual, totalChars, partHashes });

    if (!previous) {
      return { status: 'first', totalChars, chunkCount: chunkHashes.length };
    }

    const base: PromptPrefixObservation = {
      status: 'append',
      totalChars,
      chunkCount: chunkHashes.length,
      prevTotalChars: previous.totalChars,
      prevChunkCount: previous.chunkHashes.length,
    };

    // 1. Compare the previous COMPLETE chunks against ours at the same offsets.
    const sharedComplete = Math.min(previous.chunkHashes.length, chunkHashes.length);
    for (let i = 0; i < sharedComplete; i++) {
      if (previous.chunkHashes[i] !== chunkHashes[i]) {
        return this.divergent(base, previous, partHashes, i, i * this.chunkChars);
      }
    }
    if (chunkHashes.length < previous.chunkHashes.length) {
      // Payload shrank below the previous complete-chunk region: truncation.
      return this.divergent(base, previous, partHashes, chunkHashes.length, totalChars);
    }

    // 2. The previous residual must be a literal prefix of the current content
    //    at the same offset for the payload to be a pure extension.
    const prevCompleteLen = previous.chunkHashes.length * this.chunkChars;
    const currentAtResidual = canonical.slice(prevCompleteLen, prevCompleteLen + previous.residual.length);
    if (currentAtResidual !== previous.residual) {
      let mismatchAt = 0;
      const overlap = Math.min(currentAtResidual.length, previous.residual.length);
      while (mismatchAt < overlap && currentAtResidual[mismatchAt] === previous.residual[mismatchAt]) mismatchAt++;
      return this.divergent(base, previous, partHashes, previous.chunkHashes.length, prevCompleteLen + mismatchAt);
    }

    if (totalChars === previous.totalChars) {
      return { ...base, status: 'identical' };
    }
    return base; // append
  }

  /** Forget a session (e.g. after an intentional full-context rewrite). */
  reset(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  private divergent(
    base: PromptPrefixObservation,
    previous: SessionFingerprint,
    currentPartHashes: SessionFingerprint['partHashes'],
    firstDivergentChunk: number,
    divergentCharOffset: number,
  ): PromptPrefixObservation {
    // Exact attribution via per-part hashes: the first part whose (label, hash)
    // no longer matches the previous request is the mutation owner. Chunk index
    // and char offset stay as coarse position info.
    const shared = Math.min(previous.partHashes.length, currentPartHashes.length);
    let part: SessionFingerprint['partHashes'][number] | undefined;
    let partClass: string | undefined;
    for (let i = 0; i < shared; i++) {
      const prev = previous.partHashes[i]!;
      const curr = currentPartHashes[i]!;
      if (prev.label !== curr.label || prev.hash !== curr.hash) {
        part = curr;
        partClass = curr.partClass;
        break;
      }
    }
    if (!part && currentPartHashes.length < previous.partHashes.length) {
      // Every shared part matches but the payload lost parts: truncation.
      return {
        ...base,
        status: 'divergent',
        firstDivergentChunk,
        divergentCharOffset,
        divergentPart: 'payload-truncated',
        divergentPartClass: 'truncation',
      };
    }
    return {
      ...base,
      status: 'divergent',
      firstDivergentChunk,
      divergentCharOffset,
      divergentPart: part?.label ?? 'unknown',
      divergentPartClass: partClass ?? 'unknown',
    };
  }

  private remember(sessionKey: string, fp: SessionFingerprint): void {
    // LRU: re-insert moves the key to the end; evict the oldest beyond cap.
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, fp);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}
