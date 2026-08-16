/**
 * SCLI-195: cross-turn guard for expensive message-feed loops.
 *
 * The existing LoopDetector sees repeated tool calls inside one model turn. The
 * reika incident was a different failure class: Connect kept feeding new turns,
 * each with a huge prompt prefill. This guard watches completed turns across
 * messages and pauses the inbox when a high-cost turn rate repeats.
 *
 * Prefill-aware costing (2026-07): do NOT treat full `input_tokens` as the cost
 * when most of the prompt is a prefix-cache hit or a stable append-only growth.
 * Trip on estimated **prefill / uncached** mass instead, so genuine long-context
 * work (large cached prompt, small suffix each turn) is not force-paused.
 *
 * Tool-call productivity (2026-07): agent turns that issue tool calls are real
 * work even with tiny prose output. Input >> completion is normal (tool results
 * re-enter as prompt). Do not pause for that shape — only for high-prefill
 * *sterile* turns (no tools + negligible text), i.e. empty feed/spin loops.
 */

export interface ExpensiveTurnGuardConfig {
  enabled: boolean;
  windowMs: number;
  minTurns: number;
  /** Minimum *prefill* tokens for a turn to count as expensive (not full prompt). */
  minPromptTokens: number;
  /**
   * Legacy ratio floor (prefill:text). Kept for diagnostics/env compatibility;
   * trip decisions use sterile high-prefill counts, not this ratio, because
   * tool-only turns legitimately have tiny text output.
   */
  minPromptOutputRatio: number;
  /**
   * Text-only turns with fewer than this many completion tokens (and zero tools)
   * count as sterile. Default is generous so short "ok" acks without tools still
   * count as barren when paired with huge prefills.
   */
  minProductiveOutputTokens: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  notifyCooldownMs: number;
  /**
   * When provider TTFT is at least this many ms and the prompt is large, treat
   * the turn as a cold prefill (charge full input) even if size only grew a little.
   */
  coldTtftMs: number;
}

export interface ExpensiveTurnSample {
  now: number;
  inputTokens: number;
  outputTokens: number;
  /** Number of tool calls the model issued this completion (0 = text-only / empty). */
  toolCallCount?: number;
  /** Provider cache-read tokens when reported (Anthropic / some OpenAI-compatible). */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** True when the runtime detected a prompt-prefix diverge / cache bust this turn. */
  prefixCacheBusted?: boolean;
  /** Time-to-first-token for this completion, when measured. */
  ttftMs?: number | null;
  source?: string;
  channelType?: string;
}

interface StoredSample extends ExpensiveTurnSample {
  /** Estimated prefill / uncached tokens for this turn (guard cost basis). */
  prefillTokens: number;
}

export interface ExpensiveTurnGuardTrip {
  action: 'pause';
  reason: 'expensive-turn-rate';
  turnCount: number;
  callsPerMinute: number;
  /** Sum of full prompt input tokens (diagnostic only). */
  inputTokens: number;
  /** Sum of estimated prefill/uncached tokens (cost basis). */
  prefillTokens: number;
  outputTokens: number;
  /** Total tool calls across sterile expensive samples (usually 0). */
  toolCallCount: number;
  /** prefillTokens / max(1, outputTokens) — diagnostic only. */
  promptOutputRatio: number;
  promptTokenThreshold: number;
  windowMs: number;
  backoffMs: number;
  pauseUntil: number;
  notify: boolean;
}

export type ExpensiveTurnGuardDecision = { action: 'ok' } | ExpensiveTurnGuardTrip;

const DEFAULT_CONFIG: ExpensiveTurnGuardConfig = {
  enabled: true,
  windowMs: 60_000,
  minTurns: 4,
  minPromptTokens: 100_000,
  minPromptOutputRatio: 100,
  minProductiveOutputTokens: 32,
  baseBackoffMs: 5 * 60_000,
  maxBackoffMs: 15 * 60_000,
  notifyCooldownMs: 15 * 60_000,
  coldTtftMs: 15_000,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function expensiveTurnGuardConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ExpensiveTurnGuardConfig {
  return {
    enabled: env['SHIZUHA_EXPENSIVE_TURN_GUARD_DISABLED'] !== '1',
    windowMs: positiveInt(env['SHIZUHA_EXPENSIVE_TURN_WINDOW_MS'], DEFAULT_CONFIG.windowMs),
    minTurns: positiveInt(env['SHIZUHA_EXPENSIVE_TURN_MIN_TURNS'], DEFAULT_CONFIG.minTurns),
    minPromptTokens: positiveInt(env['SHIZUHA_EXPENSIVE_TURN_PROMPT_TOKENS'], DEFAULT_CONFIG.minPromptTokens),
    minPromptOutputRatio: nonNegativeInt(env['SHIZUHA_EXPENSIVE_TURN_PROMPT_OUTPUT_RATIO'], DEFAULT_CONFIG.minPromptOutputRatio),
    minProductiveOutputTokens: nonNegativeInt(
      env['SHIZUHA_EXPENSIVE_TURN_MIN_PRODUCTIVE_OUTPUT_TOKENS'],
      DEFAULT_CONFIG.minProductiveOutputTokens,
    ),
    baseBackoffMs: positiveInt(env['SHIZUHA_EXPENSIVE_TURN_BACKOFF_MS'], DEFAULT_CONFIG.baseBackoffMs),
    maxBackoffMs: positiveInt(env['SHIZUHA_EXPENSIVE_TURN_MAX_BACKOFF_MS'], DEFAULT_CONFIG.maxBackoffMs),
    notifyCooldownMs: positiveInt(env['SHIZUHA_EXPENSIVE_TURN_NOTIFY_COOLDOWN_MS'], DEFAULT_CONFIG.notifyCooldownMs),
    coldTtftMs: positiveInt(env['SHIZUHA_EXPENSIVE_TURN_COLD_TTFT_MS'], DEFAULT_CONFIG.coldTtftMs),
  };
}

/**
 * A turn is productive (not a spin) if it issued any tool call, or produced
 * non-trivial text. Tool-only turns with tiny prose are normal agent work.
 */
export function isSterileTurn(
  sample: Pick<ExpensiveTurnSample, 'outputTokens' | 'toolCallCount'>,
  minProductiveOutputTokens: number = DEFAULT_CONFIG.minProductiveOutputTokens,
): boolean {
  const tools = Math.max(0, Math.floor(sample.toolCallCount ?? 0));
  if (tools > 0) return false;
  return Math.max(0, sample.outputTokens || 0) < minProductiveOutputTokens;
}

/**
 * Estimate tokens that actually needed prefill this turn.
 *
 * Priority:
 * 1. Explicit cache_read / cache_creation from the provider.
 * 2. Append-only growth vs previous sample (vLLM often reports full prompt size
 *    every turn; the delta approximates the new suffix when the prefix is cached).
 * 3. Plateau (same large size, no cache stats) → charge full input (re-prefill /
 *    replay risk; preserves SCLI-415 bulk-release protection).
 * 4. First sample / context shrink → charge full input once.
 * 5. prefixCacheBusted or very slow TTFT on a large prompt → force full charge.
 */
export function estimatePrefillTokens(
  sample: Pick<
    ExpensiveTurnSample,
    'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'prefixCacheBusted' | 'ttftMs'
  >,
  previous: Pick<StoredSample, 'inputTokens'> | null,
  config: Pick<ExpensiveTurnGuardConfig, 'minPromptTokens' | 'coldTtftMs'> = DEFAULT_CONFIG,
): number {
  const input = Math.max(0, Math.floor(sample.inputTokens || 0));
  const create = Math.max(0, Math.floor(sample.cacheCreationTokens ?? 0));
  const readRaw = sample.cacheReadTokens;

  let prefill: number;
  if (readRaw != null && Number.isFinite(readRaw)) {
    const read = Math.max(0, Math.floor(readRaw));
    // Common shapes:
    // - input includes cached portion: prefill = input - read + create
    // - input is non-cached only (Anthropic): prefill = input + create
    if (input >= read) {
      prefill = input - read + create;
    } else {
      prefill = input + create;
    }
  } else if (previous && input > previous.inputTokens) {
    // Growing transcript without cache telemetry: only the suffix is new work.
    prefill = input - previous.inputTokens;
  } else if (previous && input === previous.inputTokens) {
    // Stable size, no cache proof → assume full re-prefill (feed loops / replay).
    prefill = input;
  } else {
    // First sample or compacted/shrunk context.
    prefill = input;
  }

  if (sample.prefixCacheBusted) {
    prefill = Math.max(prefill, input);
  }
  if (
    sample.ttftMs != null
    && Number.isFinite(sample.ttftMs)
    && sample.ttftMs >= config.coldTtftMs
    && input >= config.minPromptTokens
  ) {
    prefill = Math.max(prefill, input);
  }

  return Math.max(0, prefill);
}

/** Team slug → cluster-manager username (mirrors daemon auto-andon map for common pods). */
const TEAM_LEAD_BY_SLUG: Record<string, string> = {
  engineering: 'ryo',
  devops: 'ichi',
  architecture: 'aoi',
  review: 'revi',
  security: 'akira',
  qa: 'zen',
  documentation: 'yuki',
  analytics: 'tomo',
  product: 'nao',
  research: 'yuki',
  knowledge: 'yuki',
  merge: 'aoi',
};

function leadForTeamSlug(team: string | undefined): string | undefined {
  const slug = (team || '').trim().toLowerCase();
  if (!slug) return undefined;
  return TEAM_LEAD_BY_SLUG[slug];
}

/**
 * Resolve who to DM when the expensive-turn guard trips.
 *
 * SCLI-345 / Ichi: AGENT_TEAM is often absent on k8s pods. Fall back to
 * AGENT_EFFECTIVE_CAPABILITY_SOURCE_TEAMS (Hive effective-capabilities) and
 * then a safe engineering default so guard trips never silently drop.
 */
export function expensiveTurnGuardNotifyUsername(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const currentUsername = (env['AGENT_USERNAME'] || '').trim().toLowerCase();
  const usableRecipient = (candidate: string | undefined): string | undefined => {
    const username = candidate?.trim();
    if (!username || username.toLowerCase() === currentUsername) return undefined;
    return username;
  };
  const explicit = env['SHIZUHA_EXPENSIVE_TURN_NOTIFY_USERNAME']
    || env['SHIZUHA_LOOP_GUARD_NOTIFY_USERNAME']
    || env['AGENT_LEAD_USERNAME']
    || env['AGENT_TEAM_LEAD_USERNAME']
    || env['SHIZUHA_AGENT_LEAD_USERNAME'];
  const explicitRecipient = usableRecipient(explicit);
  if (explicitRecipient) return explicitRecipient;

  const fromAgentTeam = usableRecipient(leadForTeamSlug(env['AGENT_TEAM']));
  if (fromAgentTeam) return fromAgentTeam;

  // Effective source teams (comma-separated) — first known lead wins.
  const sourceTeams = (env['AGENT_EFFECTIVE_CAPABILITY_SOURCE_TEAMS'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const team of sourceTeams) {
    const lead = usableRecipient(leadForTeamSlug(team));
    if (lead) return lead;
  }

  // Last resort: a different cluster manager so trips are never silent and a
  // pod lead (for example Zen in QA) never attempts an invalid DM to itself.
  if (env['SHIZUHA_EXPENSIVE_TURN_NOTIFY_DEFAULT'] === '0') return undefined;
  return ['ryo', 'aoi', 'ichi'].find((username) => username !== currentUsername);
}

export class ExpensiveTurnGuard {
  private samples: StoredSample[] = [];
  // SCLI-415 (reika P2): in-window counts cannot measure how many turns one
  // replay row cost, because samples age out DURING the row -- and ageing out
  // is the pump's steady state, since it sleeps until expiry. A monotonic
  // total is the only signal that cannot be masked by expiry.
  private totalExpensiveSamples = 0;
  private pauseUntil = 0;
  private tripCount = 0;
  private lastNotifyAt = 0;

  constructor(private readonly config: ExpensiveTurnGuardConfig = DEFAULT_CONFIG) {}

  remainingPauseMs(now = Date.now()): number {
    return Math.max(0, this.pauseUntil - now);
  }

  /**
   * SCLI-415: pacing for BACKGROUND deferred-feed replay, derived from the LIVE
   * thresholds rather than a constant.
   *
   * `record()` trips at `expensive.length >= minTurns` inside `windowMs`, so
   * replay is structurally incapable of tripping the guard on its own iff it
   * can never place `minTurns` turns in one window. Allowing at most
   * `K = minTurns - 1` replay turns per window and spacing them by `S` gives
   * `floor(windowMs / S) + 1` turns per window; choosing
   * `S = floor(windowMs / K) + 1` keeps that at `<= K < minTurns`.
   *
   * Deriving here (not at the call site) is deliberate: production overrides
   * the defaults via SHIZUHA_EXPENSIVE_TURN_MIN_TURNS / _WINDOW_MS — agent-ni
   * ran minTurns=8/window=120s against defaults of 4/60s — so any constant
   * chosen against DEFAULT_CONFIG would be wrong live by a factor of two.
   *
   * `maxInFlight` is 1 per the accepted HLD: exactly one row moves to
   * `releasing` and is handed to the inbox before the next is considered.
   */
  replayPacing(): { maxInFlight: number; minSpacingMs: number; perWindowBudget: number } {
    if (!this.config.enabled) {
      return { maxInFlight: 1, minSpacingMs: 0, perWindowBudget: Number.MAX_SAFE_INTEGER };
    }
    const perWindowBudget = Math.max(1, this.config.minTurns - 1);
    return {
      maxInFlight: 1,
      minSpacingMs: Math.floor(this.config.windowMs / perWindowBudget) + 1,
      perWindowBudget,
    };
  }

  private isHighPrefill(prefillTokens: number): boolean {
    return prefillTokens >= this.config.minPromptTokens;
  }

  /** High prefill + no tools + negligible text — the only shape we force-pause. */
  private isSterileExpensive(sample: StoredSample): boolean {
    const minOut = this.config.minProductiveOutputTokens
      ?? DEFAULT_CONFIG.minProductiveOutputTokens;
    return this.isHighPrefill(sample.prefillTokens)
      && isSterileTurn(sample, minOut);
  }

  /**
   * SCLI-415 (reika P1): sterile expensive samples currently inside the window.
   *
   * Spacing alone is denominated in ROWS, but `record()` is called once per
   * provider TURN (agent-process.ts:3535, inside the turnIndex loop), so a
   * replay row that makes a tool call contributes 2+ samples and the delivered
   * bound becomes `turns x (minTurns - 1)`. Admission must therefore be checked
   * against the real sample count, which only the guard can answer.
   *
   * Tool-bearing turns no longer count — they are productive even with tiny text.
   */
  expensiveSamplesInWindow(now = Date.now()): number {
    if (!this.config.enabled) return 0;
    return this.samples.filter(
      (s) => now - s.now <= this.config.windowMs && this.isSterileExpensive(s),
    ).length;
  }

  /**
   * SCLI-415: how long until the oldest in-window sterile-expensive sample ages out.
   *
   * Lets a blocked replay pump wait exactly as long as it must instead of
   * polling, and returns 0 when nothing is in-window.
   */
  msUntilExpensiveSampleExpiry(now = Date.now()): number {
    if (!this.config.enabled) return 0;
    const inWindow = this.samples.filter(
      (s) => now - s.now <= this.config.windowMs && this.isSterileExpensive(s),
    );
    if (inWindow.length === 0) return 0;
    const oldest = Math.min(...inWindow.map((s) => s.now));
    return Math.max(0, oldest + this.config.windowMs - now) + 1;
  }

  record(sample: ExpensiveTurnSample): ExpensiveTurnGuardDecision {
    if (!this.config.enabled) return { action: 'ok' };
    const now = sample.now;
    if (now < this.pauseUntil) return { action: 'ok' };

    const previous = this.samples.length > 0 ? this.samples[this.samples.length - 1]! : null;
    const prefillTokens = estimatePrefillTokens(sample, previous, this.config);
    const stored: StoredSample = { ...sample, prefillTokens };

    this.samples.push(stored);
    if (this.isSterileExpensive(stored)) this.totalExpensiveSamples += 1;
    this.samples = this.samples.filter((s) => now - s.now <= this.config.windowMs);

    // Only sterile high-prefill turns count. Tool-calling agents with fat
    // contexts (tool results re-fed as input) must not be force-paused.
    const expensive = this.samples.filter((s) => this.isSterileExpensive(s));
    if (expensive.length < this.config.minTurns) return { action: 'ok' };

    const inputTokens = expensive.reduce((sum, s) => sum + Math.max(0, s.inputTokens), 0);
    const prefillSum = expensive.reduce((sum, s) => sum + Math.max(0, s.prefillTokens), 0);
    const outputTokens = expensive.reduce((sum, s) => sum + Math.max(0, s.outputTokens), 0);
    const toolCallCount = expensive.reduce((sum, s) => sum + Math.max(0, s.toolCallCount ?? 0), 0);
    const promptOutputRatio = prefillSum / Math.max(1, outputTokens);

    const firstTs = expensive[0]!.now;
    const lastTs = expensive[expensive.length - 1]!.now;
    const elapsedMs = Math.max(1_000, lastTs - firstTs || this.config.windowMs);
    const callsPerMinute = expensive.length / (elapsedMs / 60_000);
    const backoffMs = Math.min(
      this.config.maxBackoffMs,
      this.config.baseBackoffMs * (2 ** this.tripCount),
    );
    this.tripCount += 1;
    this.pauseUntil = now + backoffMs;
    const notify = now - this.lastNotifyAt >= this.config.notifyCooldownMs;
    if (notify) this.lastNotifyAt = now;

    return {
      action: 'pause',
      reason: 'expensive-turn-rate',
      turnCount: expensive.length,
      callsPerMinute,
      inputTokens,
      prefillTokens: prefillSum,
      outputTokens,
      toolCallCount,
      promptOutputRatio,
      promptTokenThreshold: this.config.minPromptTokens,
      windowMs: this.config.windowMs,
      backoffMs,
      pauseUntil: this.pauseUntil,
      notify,
    };
  }

  /** SCLI-415: monotonic count of expensive samples ever recorded. */
  totalExpensiveSampleCount(): number {
    return this.totalExpensiveSamples;
  }

  reset(): void {
    this.samples = [];
    this.pauseUntil = 0;
    this.tripCount = 0;
    this.lastNotifyAt = 0;
  }
}
