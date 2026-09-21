import type { Message } from './types.js';
import type { ToolDefinition } from '../tools/types.js';
import { countTokens } from '../utils/tokens.js';
import { effectiveContextTokens, estimateTokens, getSafetyFactor } from '../prompt/context.js';

export type PromptSourceKind = 'heartbeat' | 'scheduled' | 'user' | 'unknown';
export type HeartbeatCompactionAction = 'none' | 'compact';

export interface PromptTokenBudgetEstimate {
  promptTokenEstimate: number;
  systemOverheadTokens: number;
  messageTokens: number;
  toolDefinitionTokens: number;
  sourceKind: PromptSourceKind;
}

export interface HeartbeatBudgetConfig {
  softBudgetTokens: number;
  hardBudgetTokens: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFraction(raw: string | undefined, fallback: number): number {
  const v = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
}

/** Soft heartbeat budget as a fraction of the announced context window. */
const DEFAULT_HEARTBEAT_SOFT_FRACTION = 0.70;
/** Hard heartbeat budget as a fraction of the announced context window. */
const DEFAULT_HEARTBEAT_HARD_FRACTION = 0.85;
/** Absolute fallbacks only when the window is not yet known (pre-discovery). */
const DEFAULT_HEARTBEAT_SOFT_TOKENS = 30_000;
const DEFAULT_HEARTBEAT_HARD_TOKENS = 45_000;
/**
 * PLAT-9203: bounded ABSOLUTE budgets for eternal (heartbeat) sessions.
 *
 * Evidence (ichi's Cortex forensics, agent-aoi 2026-08-27): 726 requests in
 * 24h at avg 182K prompt tokens, ratcheting 173K→187K — compaction never
 * engaged. Root cause: with a known window, the soft budget defaulted to
 * 0.70 × window (≈190K on a 272K model) and the compaction trigger to 0.75 ×
 * window (≈204K) — the ratchet stabilizes just BELOW both, so an eternal
 * session re-ships its whole accumulated context every scheduler tick
 * instead of compacting to a bounded steady-state.
 *
 * Default posture (supersedes the fraction default for budget purposes):
 * soft 120K / hard 160K absolute — compaction engages well below the lane
 * limit and the summarize-and-trim lands the prompt at a flat steady-state.
 * `SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE=proportional` restores the legacy
 * window-fraction behavior. The 2026-08-17 never-skip guarantee is
 * unaffected: budgets are compaction hints, never an admission gate (the
 * skip path was removed; loop.ts proceeds on every heartbeat regardless of
 * budget state).
 */
const DEFAULT_HEARTBEAT_ETERNAL_SOFT_TOKENS = 120_000;
const DEFAULT_HEARTBEAT_ETERNAL_HARD_TOKENS = 160_000;

/**
 * Heartbeat soft/hard budgets are compaction *hints*, never a skip gate.
 *
 * Operator 2026-08-17: even at very high ctx, do not skip heartbeats.
 * Fleet pods still carry leftover 80k/100k absolute pins next to 0.70/0.85
 * fractions. When the provider window is known, fractions win — otherwise a
 * 282k DeepSeek session (524k window) looked over-budget and the gateway
 * skipped the Pulse turn (live 2/8 admissions).
 *
 * PLAT-9203 (2026-09-18): the fraction DEFAULT caused the eternal-session
 * prompt ratchet (aoi 173K→187K, compaction never engaging below the
 * window-proportional thresholds). The default is now the bounded absolute
 * posture (soft 120K / hard 160K); `proportional` opts back into window
 * fractions. The never-skip guarantee is structural (loop.ts), not a
 * function of which budget source wins.
 */
export function heartbeatBudgetConfig(
  maxContextTokens?: number,
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatBudgetConfig {
  const window = typeof maxContextTokens === 'number' && maxContextTokens > 0
    ? maxContextTokens
    : 0;
  const mode = String(env.SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE || '').trim().toLowerCase();
  const forceProportional = mode === 'proportional' || mode === 'fraction';

  if (window > 0 && forceProportional) {
    const softFrac = parseFraction(env.SHIZUHA_HEARTBEAT_CONTEXT_SOFT_FRACTION, DEFAULT_HEARTBEAT_SOFT_FRACTION);
    const hardFrac = parseFraction(env.SHIZUHA_HEARTBEAT_CONTEXT_HARD_FRACTION, DEFAULT_HEARTBEAT_HARD_FRACTION);
    const soft = Math.max(8_000, Math.floor(window * softFrac));
    const hard = Math.max(soft, Math.floor(window * Math.max(softFrac, hardFrac)));
    return { softBudgetTokens: soft, hardBudgetTokens: hard };
  }

  // Absolute posture (PLAT-9203 default; also the pre-discovery fallback).
  // Eternal sessions bound at soft 120K / hard 160K regardless of window;
  // window-less deployments keep the audited 30K/45K fallbacks.
  const softDefault = window > 0 ? DEFAULT_HEARTBEAT_ETERNAL_SOFT_TOKENS : DEFAULT_HEARTBEAT_SOFT_TOKENS;
  const hardDefault = window > 0 ? DEFAULT_HEARTBEAT_ETERNAL_HARD_TOKENS : DEFAULT_HEARTBEAT_HARD_TOKENS;
  const soft = parsePositiveInt(env.SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS, softDefault);
  const hard = parsePositiveInt(env.SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS, Math.max(soft, hardDefault));
  return { softBudgetTokens: soft, hardBudgetTokens: Math.max(soft, hard) };
}

export function resolveContextPreflightGuardTokens(maxContextTokens: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number.parseInt(env.SHIZUHA_TUI_PREFLIGHT_GUARD_TOKENS ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  const proportionalGuard = Math.ceil(maxContextTokens * 0.125);
  return Math.max(1_024, Math.min(65_536, proportionalGuard));
}

export function resolveInteractivePreflightCeilingTokens(
  maxContextTokens: number,
  outputReserveTokens: number,
  guardTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const contextCeiling = Math.max(1_000, maxContextTokens - outputReserveTokens - guardTokens);
  const override = Number.parseInt(env.SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS ?? '', 10);
  if (Number.isFinite(override) && override > 0) {
    return Math.max(1_000, Math.min(contextCeiling, override));
  }

  // Large interactive TUI sessions: keep a latency-oriented ceiling as a
  // *fraction* of the announced window (not a fixed 128K), so 512K backends
  // can use far more of their window while still leaving room for the next
  // turn. Override with SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS when needed.
  if (maxContextTokens >= 200_000) {
    const frac = parseFraction(env.SHIZUHA_TUI_PREFLIGHT_TARGET_FRACTION, 0.70);
    const responsiveCeiling = Math.floor(maxContextTokens * frac);
    return Math.max(1_000, Math.min(contextCeiling, responsiveCeiling));
  }
  return Math.max(1_000, contextCeiling);
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool_result') return block.content;
    return '';
  }).join('\n');
}

/**
 * Optional lean-head helper. Heartbeats must still run at high ctx;
 * do not use this as a skip substitute.
 */
export function keepHeartbeatNudgeOnly(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (!last || last.role !== 'user') return [];
  if (classifyPromptSource([last]) !== 'heartbeat') return [];
  return [last];
}

export function classifyPromptSource(messages: Message[], initialPrompt?: string): PromptSourceKind {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = initialPrompt ?? (lastUser ? messageText(lastUser) : '');
  return classifyPromptText(prompt);
}

/**
 * PLAT-9185: classify a raw incoming prompt text (before any session resume
 * decision). The pipe entrypoint needs this to enforce the runtime lifecycle
 * invariant — autonomous heartbeat/scheduled turns must start a CLEAN session
 * and never inherit the predecessor transcript — before `messages` exist.
 */
export function classifyPromptText(prompt: string): PromptSourceKind {
  if (/^\s*\[(heartbeat|HEARTBEAT)\]/i.test(prompt) || /^\s*\[Heartbeat\]/.test(prompt)) return 'heartbeat';
  if (/automatic sync|schedule(d)? wakeup|cron/i.test(prompt)) return 'scheduled';
  return prompt ? 'user' : 'unknown';
}

export function estimatePromptTokenBudget(args: {
  messages: Message[];
  systemPrompt: string;
  toolDefs: ToolDefinition[];
  model?: string;
  sourceKind?: PromptSourceKind;
  /** Provider-tokenizer truth for the preceding request, when available. */
  reportedPromptTokens?: number;
  /** Uninflated estimate for the exact request that produced provider truth. */
  reportedRawEstimateTokens?: number;
}): PromptTokenBudgetEstimate {
  const systemRaw = countTokens(args.systemPrompt, args.model);
  const toolRaw = args.toolDefs.length > 0 ? countTokens(JSON.stringify(args.toolDefs), args.model) : 0;
  const messageRaw = estimateTokens(args.messages, args.model);
  const rawTotal = systemRaw + toolRaw + messageRaw;
  const promptTokenEstimate = effectiveContextTokens(
    args.messages,
    args.model,
    systemRaw + toolRaw,
    args.reportedPromptTokens,
    args.reportedRawEstimateTokens,
  );
  const scale = rawTotal > 0
    ? promptTokenEstimate / rawTotal
    : getSafetyFactor(args.model);
  const systemOverheadTokens = Math.ceil(systemRaw * scale);
  const toolDefinitionTokens = Math.ceil(toolRaw * scale);
  return {
    promptTokenEstimate,
    systemOverheadTokens,
    toolDefinitionTokens,
    messageTokens: Math.max(
      0,
      promptTokenEstimate - systemOverheadTokens - toolDefinitionTokens,
    ),
    sourceKind: args.sourceKind ?? classifyPromptSource(args.messages),
  };
}
