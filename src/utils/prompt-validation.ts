/**
 * Prompt request validation (SCLI-413).
 *
 * The /v1/query/stream and /v1/query/ndjson contract requires a non-empty
 * STRING `prompt`. A falsy check alone (`!prompt`) admits whitespace-only
 * strings, numbers, booleans, and objects — all of which are truthy — letting
 * invalid bodies cross the full agent/provider boundary as autonomous SSE
 * turns. Validate the TYPE and require non-whitespace content before any
 * session/inbox/provider/tool work.
 */
export function isValidPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Normalize a valid prompt (trim) — only call after isValidPrompt. */
export function normalizePrompt(value: string): string {
  return value.trim();
}
