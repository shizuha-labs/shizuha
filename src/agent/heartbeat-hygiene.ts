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
 * Heartbeat soft/hard budgets for pre-turn compaction / reset gates.
 *
 * Explicit absolute token settings are operator intent and therefore win over
 * window-derived defaults. This matters for the fleet contract, which already
 * renders 80k/100k pins: silently ignoring them let active sessions grow past
 * 250K and made every cache eviction an interactive multi-minute prefill.
 *
 * Precedence: explicit absolute token values (or mode=absolute), then window
 * fractions, then the small unknown-window defaults.
 *
 * When the window is unknown, fall back to absolute token env / small defaults.
 * Set `SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE=absolute` to force the legacy
 * absolute token knobs even when a window is known.
 */
export function heartbeatBudgetConfig(
  maxContextTokens?: number,
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatBudgetConfig {
  const window = typeof maxContextTokens === 'number' && maxContextTokens > 0
    ? maxContextTokens
    : 0;
  const mode = String(env.SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE || '').trim().toLowerCase();
  const forceAbsolute = mode === 'absolute';
  const hasAbsoluteOverride = Boolean(
    env.SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS
    || env.SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS,
  );

  if (window > 0 && !forceAbsolute && !hasAbsoluteOverride) {
    const softFrac = parseFraction(env.SHIZUHA_HEARTBEAT_CONTEXT_SOFT_FRACTION, DEFAULT_HEARTBEAT_SOFT_FRACTION);
    const hardFrac = parseFraction(env.SHIZUHA_HEARTBEAT_CONTEXT_HARD_FRACTION, DEFAULT_HEARTBEAT_HARD_FRACTION);
    const soft = Math.max(8_000, Math.floor(window * softFrac));
    const hard = Math.max(soft, Math.floor(window * Math.max(softFrac, hardFrac)));
    return { softBudgetTokens: soft, hardBudgetTokens: hard };
  }

  const soft = parsePositiveInt(env.SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS, DEFAULT_HEARTBEAT_SOFT_TOKENS);
  const hard = parsePositiveInt(env.SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS, DEFAULT_HEARTBEAT_HARD_TOKENS);
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

export function classifyPromptSource(messages: Message[], initialPrompt?: string): PromptSourceKind {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = initialPrompt ?? (lastUser ? messageText(lastUser) : '');
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
