/**
 * CTX-5382: rolling-hour spend breaker + usage ledger for the Hive direct xAI
 * path (`xai:grok-*` → Hive TokenPool lease → Grok CLI chat proxy).
 *
 * Cortex meters managed Grok traffic with its own breaker. The direct path
 * bypasses Cortex, so the runtime bounds its own spend per seat:
 *
 *   - total cap   : prompt (incl. cached) + output tokens in the last hour
 *   - uncached cap: (prompt - cached) + output tokens in the last hour — the
 *                   part a prefix-cache regression would inflate
 *
 * State is persisted next to the agent's workspace so a pod restart does not
 * reset the window. Every completed call is appended to a JSONL ledger so the
 * operator monitor can compute per-call cached ratios without touching xAI.
 * No secrets are ever written: only token counts, model, session id and the
 * non-secret account label.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';

export const XAI_DIRECT_DEFAULT_HOURLY_TOTAL_CAP = 40_000_000;
export const XAI_DIRECT_DEFAULT_HOURLY_UNCACHED_CAP = 8_000_000;
const WINDOW_MS = 60 * 60 * 1000;
const LEDGER_MAX_BYTES = 20 * 1024 * 1024;

export interface XaiDirectUsageRecord {
  model: string;
  sessionId: string;
  account: string;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  latencyMs?: number;
}

interface WindowEntry { t: number; total: number; uncached: number }

export class XaiDirectBudgetExceededError extends Error {
  readonly status = 429;
  readonly code = 'xai_direct_budget_exhausted';
  readonly retryable = false;
  constructor(readonly kind: 'total' | 'uncached', readonly used: number, readonly cap: number, readonly resetsAt: number) {
    super(
      `xAI direct hourly ${kind} token cap reached (${used}/${cap}); `
      + `breaker open until ${new Date(resetsAt).toISOString()} — rate limit, falling back`,
    );
    this.name = 'XaiDirectBudgetExceededError';
  }
}

function parseCap(raw: string | undefined, fallback: number): number {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'off' || value === 'disabled') return Number.POSITIVE_INFINITY;
  const n = Number(value.replace(/_/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function xaiDirectStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env['SHIZUHA_XAI_DIRECT_STATE_DIR'] || '').trim();
  if (explicit) return explicit;
  return path.join(env['HOME'] || os.homedir(), '.shizuha', 'xai-direct');
}

export class XaiDirectBudget {
  readonly totalCap: number;
  readonly uncachedCap: number;
  readonly statePath: string;
  readonly ledgerPath: string;
  private entries: WindowEntry[] = [];
  private readonly now: () => number;

  constructor(opts: {
    dir?: string;
    totalCap?: number;
    uncachedCap?: number;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
  } = {}) {
    const env = opts.env ?? process.env;
    const dir = opts.dir ?? xaiDirectStateDir(env);
    this.totalCap = opts.totalCap ?? parseCap(env['SHIZUHA_XAI_DIRECT_HOURLY_TOKEN_CAP'], XAI_DIRECT_DEFAULT_HOURLY_TOTAL_CAP);
    this.uncachedCap = opts.uncachedCap
      ?? parseCap(env['SHIZUHA_XAI_DIRECT_HOURLY_UNCACHED_CAP'], XAI_DIRECT_DEFAULT_HOURLY_UNCACHED_CAP);
    this.statePath = path.join(dir, 'budget.json');
    this.ledgerPath = path.join(dir, 'usage.jsonl');
    this.now = opts.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as { entries?: WindowEntry[] };
      this.entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter((e) => Number.isFinite(e?.t) && Number.isFinite(e?.total) && Number.isFinite(e?.uncached))
        : [];
    } catch {
      this.entries = [];
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - WINDOW_MS;
    this.entries = this.entries.filter((e) => e.t > cutoff);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries }), { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      logger.warn({ err }, 'xAI direct budget state persist failed (in-memory window still enforced)');
    }
  }

  usage(): { total: number; uncached: number; calls: number } {
    this.prune();
    let total = 0;
    let uncached = 0;
    for (const e of this.entries) { total += e.total; uncached += e.uncached; }
    return { total, uncached, calls: this.entries.length };
  }

  /** Throws XaiDirectBudgetExceededError when either rolling cap is reached. */
  assertAvailable(): void {
    const { total, uncached } = this.usage();
    const oldest = this.entries[0]?.t ?? this.now();
    const resetsAt = oldest + WINDOW_MS;
    if (total >= this.totalCap) throw new XaiDirectBudgetExceededError('total', total, this.totalCap, resetsAt);
    if (uncached >= this.uncachedCap) throw new XaiDirectBudgetExceededError('uncached', uncached, this.uncachedCap, resetsAt);
  }

  record(rec: XaiDirectUsageRecord): void {
    const prompt = Math.max(0, Math.floor(rec.promptTokens || 0));
    const cached = Math.min(prompt, Math.max(0, Math.floor(rec.cachedTokens || 0)));
    const output = Math.max(0, Math.floor(rec.outputTokens || 0));
    const t = this.now();
    const total = prompt + output;
    const uncached = prompt - cached + output;
    this.entries.push({ t, total, uncached });
    this.prune();
    this.persist();
    const window = this.usage();
    const line = {
      ts: new Date(t).toISOString(),
      pool: 'hive',
      model: rec.model,
      session: rec.sessionId,
      account: rec.account,
      prompt_tokens: prompt,
      cached_tokens: cached,
      output_tokens: output,
      cached_ratio: prompt > 0 ? Number((cached / prompt).toFixed(4)) : null,
      latency_ms: rec.latencyMs ?? null,
      hour_total: window.total,
      hour_uncached: window.uncached,
      cap_total: Number.isFinite(this.totalCap) ? this.totalCap : null,
      cap_uncached: Number.isFinite(this.uncachedCap) ? this.uncachedCap : null,
    };
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(this.ledgerPath).size > LEDGER_MAX_BYTES) fs.renameSync(this.ledgerPath, `${this.ledgerPath}.1`);
      } catch { /* first write */ }
      fs.appendFileSync(this.ledgerPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (err) {
      logger.warn({ err }, 'xAI direct usage ledger append failed');
    }
    logger.info({ event: 'xai_direct_usage', ...line }, 'xAI direct usage');
  }
}

let shared: XaiDirectBudget | null = null;

/** One breaker per process: lease rotation (401) must not reset the window. */
export function sharedXaiDirectBudget(): XaiDirectBudget {
  if (!shared) shared = new XaiDirectBudget();
  return shared;
}

export function resetSharedXaiDirectBudgetForTests(): void {
  shared = null;
}
