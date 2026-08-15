/**
 * Request-aware post-first-frame timeout for streamed tool calls.
 *
 * Some vLLM tool parsers (notably DeepSeek DSML) buffer a complete invoke
 * before emitting the next SSE data frame.  During that interval the engine is
 * decoding normally, but a fixed short idle timer cannot distinguish it from a
 * dead stream.  Keep the ordinary fast timeout for plain text and size only
 * tool-capable requests to the maximum buffered completion.
 */
export const TOOL_PARSER_MIN_DECODE_TPS = 8;
export const TOOL_PARSER_COMPLETION_GRACE_MS = 120_000;
export const TOOL_PARSER_MAX_SERVER_TIMEOUT_MS = 7_200_000;
export const TOOL_PARSER_CLIENT_MARGIN_MS = 30_000;

export interface ToolStreamTimeoutInput {
  baseMs: number;
  maxTokens: number;
  hasTools: boolean;
  toolChoice?: unknown;
  minDecodeTps?: number;
  completionGraceMs?: number;
  maxServerTimeoutMs?: number;
  clientMarginMs?: number;
}

export function requestAwareToolStreamTimeoutMs(input: ToolStreamTimeoutInput): number {
  const baseMs = Math.max(1, Math.ceil(input.baseMs));
  if (!input.hasTools || input.toolChoice === 'none' || !Number.isFinite(input.maxTokens) || input.maxTokens <= 0) {
    return baseMs;
  }

  const minDecodeTps = Number.isFinite(input.minDecodeTps) && (input.minDecodeTps ?? 0) > 0
    ? input.minDecodeTps!
    : TOOL_PARSER_MIN_DECODE_TPS;
  const completionGraceMs = Number.isFinite(input.completionGraceMs) && (input.completionGraceMs ?? -1) >= 0
    ? input.completionGraceMs!
    : TOOL_PARSER_COMPLETION_GRACE_MS;
  const maxServerTimeoutMs = Math.max(
    baseMs,
    Number.isFinite(input.maxServerTimeoutMs) && (input.maxServerTimeoutMs ?? 0) > 0
      ? input.maxServerTimeoutMs!
      : TOOL_PARSER_MAX_SERVER_TIMEOUT_MS,
  );
  const clientMarginMs = Number.isFinite(input.clientMarginMs) && (input.clientMarginMs ?? -1) >= 0
    ? input.clientMarginMs!
    : TOOL_PARSER_CLIENT_MARGIN_MS;
  const serverBudgetMs = Math.min(
    maxServerTimeoutMs,
    Math.ceil((input.maxTokens / minDecodeTps) * 1000 + completionGraceMs),
  );
  // The client must hang up AFTER Cortex's upstream deadline, never on the
  // same millisecond.  Otherwise scheduler jitter can still create an orphan.
  return Math.max(baseMs, serverBudgetMs + clientMarginMs);
}

export function cortexAdvertisedStreamTimeoutMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('x-cortex-inter-token-timeout-seconds');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.ceil(seconds * 1000) + TOOL_PARSER_CLIENT_MARGIN_MS;
}
