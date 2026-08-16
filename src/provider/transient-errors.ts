/**
 * Classify provider/Cortex/ChatGPT stream failures that should auto-retry
 * instead of ending the interactive turn.
 *
 * OpenAI Codex intermittently returns SSE:
 *   { code: "server_error", message: "An error occurred while processing..." }
 * without a reliable retryable flag. Treat those as transient.
 *
 * Session-level policy (operator 2026-07-23): transient failures retry
 * **indefinitely** with exponential backoff + jitter. Never end a turn solely
 * because "retries exhausted" — only abort, non-transient errors (auth/policy/
 * context handled elsewhere), or intentional maintenance/pool-dry paths stop.
 */

/** Base delay for the first session-level retry (ms). */
export const TRANSIENT_RETRY_BASE_DELAY_MS = 1_000;

/** Cap between indefinite session-level retries (ms). */
export const TRANSIENT_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Exponential backoff with full jitter for the Nth retry (0-based attempt).
 * Caps at {@link TRANSIENT_RETRY_MAX_DELAY_MS}. `rand` injectable for tests.
 */
export function transientRetryDelayMs(
  attempt: number,
  rand: () => number = Math.random,
): number {
  const n = Math.max(0, attempt);
  const exp = Math.min(
    TRANSIENT_RETRY_BASE_DELAY_MS * Math.pow(2, n),
    TRANSIENT_RETRY_MAX_DELAY_MS,
  );
  const r = Math.min(1, Math.max(0, rand()));
  return Math.round(exp * (0.75 + r * 0.5));
}

/** Shortest server-requested delay we will honor (anti-thrash floor). */
export const RETRY_AFTER_MIN_MS = 1_000;

/**
 * Pull a server-supplied Retry-After off a thrown provider error.
 *
 * Providers attach it as `retryAfterMs` (already normalized from the header by
 * the provider layer). Returns null when absent or nonsensical.
 */
export function retryAfterMsFromError(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const raw = (err as { retryAfterMs?: unknown }).retryAfterMs;
  const ms = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms);
}

/**
 * Session-level backoff, preferring the server's own Retry-After when it sent one.
 *
 * Cortex answers its admission guards with an accurate hint — the latency-tail
 * guard sends `Retry-After: 5` because the lane frees on that timescale — but
 * SCLI ignored it and climbed its blind exponential to 60s. A session could
 * therefore sit a full minute after the backend was ready again (shizuha1,
 * 2026-08-03).
 *
 * Honoring the hint verbatim forever would be the opposite mistake: a condition
 * that persists for ten minutes would be polled every 5s by every agent at once.
 * So the hint is honored, clamped to [1s, 60s], and floored by a slowly
 * escalating value — responsive while the server expects a quick recovery,
 * self-throttling when it does not. Still far quicker to recover than the
 * unconditional 60s ceiling.
 */
export function resolveRetryDelayMs(input: {
  attempt: number;
  retryAfterMs?: number | null;
  rand?: () => number;
}): number {
  const rand = input.rand ?? Math.random;
  const attempt = Math.max(0, input.attempt);
  if (input.retryAfterMs == null || !Number.isFinite(input.retryAfterMs) || input.retryAfterMs <= 0) {
    return transientRetryDelayMs(attempt, rand);
  }
  const honored = Math.min(
    Math.max(input.retryAfterMs, RETRY_AFTER_MIN_MS),
    TRANSIENT_RETRY_MAX_DELAY_MS,
  );
  // Escalating floor: doubles every 4 sustained attempts, capped at 15s, so a
  // long-lived guard degrades to a poll rather than a hammer.
  const floor = Math.min(
    RETRY_AFTER_MIN_MS * Math.pow(2, Math.floor(attempt / 4)),
    15_000,
  );
  const delay = Math.min(Math.max(honored, floor), TRANSIENT_RETRY_MAX_DELAY_MS);
  const r = Math.min(1, Math.max(0, rand()));
  return Math.round(delay * (0.9 + r * 0.2)); // ±10% jitter
}

/**
 * Abort-aware sleep for retry backoff. Rejects with AbortError if already
 * aborted or if the signal fires during the wait.
 */
export function sleepMs(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Compact, human-readable cause extracted from a provider/Cortex error body.
 *
 * The retry banner used to print only `(${code || status})`, so an operator
 * watching a stalled TUI saw a bare "API error (503)" and had no way to tell a
 * dead backend apart from a deliberate admission guard. Cortex already sends
 * the actionable reason in the message — e.g. "latency tail guard: no safe
 * cold-prefill lane" — and dropping it cost a 10-minute live investigation
 * (shizuha1, 2026-08-03). Keep it short enough for one TUI line.
 */
export function summarizeFailureReason(message?: string | null, maxLen = 120): string {
  const raw = String(message ?? '').trim();
  if (!raw) return '';
  // Strip the provider prefixes that carry no information beyond the status we
  // already print ("Cortex error 503: ", "vLLM error 500 - ", …).
  let out = raw
    .replace(/^(cortex|vllm|openai|anthropic|provider)\s*error\s*\d{3}\s*[:\-–]\s*/i, '')
    .replace(/^\s*\{?\s*"?error"?\s*[:=]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Prefer the inner `message` of a JSON error envelope when one survived.
  const inner = out.match(/"message"\s*:\s*"((?:[^"\\]|\\.){3,})"/);
  if (inner?.[1]) out = inner[1].replace(/\\"/g, '"').trim();
  out = out.replace(/^[\s"'{]+|[\s"'}]+$/g, '');
  if (!out) return '';
  return out.length > maxLen ? `${out.slice(0, maxLen - 1)}…` : out;
}

/** `1m 20s` / `45s` — compact elapsed for the stall banner. */
export function formatStallDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/**
 * One consistent retry line for every SCLI surface (TUI, exec, android).
 *
 * `attempt`/`elapsedMs` are the **cumulative** stall across the whole prompt,
 * not the per-sub-turn retry index. The agentic loop starts a fresh retry
 * counter for each `executeTurn`, so the old per-loop counter reset to
 * "attempt 1" every few minutes and made a long outage look seconds old.
 */
export function formatRetryNotice(input: {
  label: string;
  code?: string | number | null;
  status?: number | null;
  message?: string | null;
  attempt: number;
  elapsedMs: number;
  delayMs: number;
  hint?: string;
}): string {
  const id = input.code || input.status || 'retryable';
  const reason = summarizeFailureReason(input.message);
  const stalled = input.elapsedMs > 0 ? `, stalled ${formatStallDuration(input.elapsedMs)}` : '';
  return `${input.label} (${id})${reason ? `: ${reason}` : ''}`
    + ` — retrying in ${Math.max(1, Math.round(input.delayMs / 1000))}s`
    + ` (attempt ${input.attempt}${stalled}, indefinite)${input.hint ?? ''}`;
}

/**
 * Deterministic config / model-selection failures (SCLI-384).
 * These must never enter the indefinite session retry loop — the user needs
 * `/model` or a valid `--model`, not backoff.
 */
export function isInvalidModelOrProviderFailure(input: {
  message?: string;
  code?: string | number | null;
  type?: string | null;
  status?: number | null;
  hadSuccessfulProviderTurn?: boolean;
}): boolean {
  const code = String(input.code ?? '').toLowerCase();
  const type = String(input.type ?? '').toLowerCase();
  const msg = String(input.message ?? '').toLowerCase();
  const blob = `${msg} ${code} ${type}`;

  // Cortex/vLLM mid-session "Model X is not available" is a drained-backend
  // blip (Q4 compiler cell, 2026-08-15: llama.cpp stayed healthy). First-turn
  // 404 / unknown id stays fail-fast (SCLI-384).
  if (
    input.hadSuccessfulProviderTurn
    && /is not available/i.test(msg)
  ) {
    return false;
  }

  if (
    code === 'model_not_found'
    || code === 'invalid_model'
    || code === 'unknown_model'
    || code === 'provider_not_found'
    || code === 'invalid_provider'
    || type === 'invalid_request_error' && /model/i.test(msg)
    || /model[_ ]?not[_ ]?found|unknown model|invalid model|no such model|does not exist|model .* unavailable for|unsupported model/i.test(blob)
    || /provider .* not (configured|available|found)|no provider found for model|not a valid provider/i.test(blob)
    || /use \/model/i.test(msg)
  ) {
    return true;
  }

  // HTTP 404 on chat/completions is almost always a bad model/route, not a blip.
  if (input.status === 404) return true;
  // 400 with model-selection language is permanent for this request.
  if (input.status === 400 && /model|provider/i.test(blob)) return true;

  return false;
}

/** Actionable copy for invalid model/provider (TUI + exec). */
export function formatInvalidModelError(model: string, detail?: string): string {
  const reason = detail?.trim() ? ` ${detail.trim().replace(/\s+/g, ' ')}` : '';
  return (
    `Invalid or unusable model "${model}".${reason}`
    + ` Use /model to pick a configured provider/model, or relaunch with a valid --model.`
  );
}

export function isTransientProviderFailure(input: {
  message?: string;
  code?: string | number | null;
  type?: string | null;
  retryable?: boolean | null;
  status?: number | null;
  hadSuccessfulProviderTurn?: boolean;
}): boolean {
  const code = String(input.code ?? '').toLowerCase();
  const type = String(input.type ?? '').toLowerCase();
  const msg = String(input.message ?? '').toLowerCase();
  const blob = `${msg} ${code} ${type}`;

  // Hard non-transient (caller may still handle context overflow separately).
  // Checked BEFORE retryable===true so a mis-flagged config error cannot loop.
  if (
    code === 'provider_endpoint_unavailable'
    ||
    /context_length|context window|input exceeds|prompt is too long|too many tokens|maximum context/i.test(blob)
  ) {
    return false;
  }

  // SCLI-384: invalid provider/model is never a transient upstream blip.
  if (isInvalidModelOrProviderFailure(input)) {
    return false;
  }

  // Mid-session Cortex "not available" is a drained replica, not a bad --model.
  if (input.hadSuccessfulProviderTurn && /is not available/i.test(msg)) {
    return true;
  }

  // Model exclusivity lease: another agent holds the sprint. Not a sick backend —
  // short session-level retries would hammer Cortex (Rui 2026-07-28). Provider
  // path does long backoff; session loop ends the turn. Must run BEFORE the
  // status>=500 blanket below (Cortex returns HTTP 503 for model_leased).
  if (
    code === 'model_leased'
    || code === 'model_leased_to_other'
    || code === 'not_hive_eligible'
    || type === 'model_leased'
    || /model_leased|leased to another agent|not_hive_eligible|not marked them eligible/i.test(blob)
  ) {
    return false;
  }

  // 401 / auth failures are NOT transient. Retrying a bad credential or a real
  // unauthorized response spins forever and confuses the operator. If a prior
  // turn in the same session already succeeded, a sudden 401 is still not
  // something we should infinite-retry — surface it so the real cause (stale
  // OAuth pool account, middleware, misclassified body) can be fixed.
  // Operator 2026-07-23: do not treat HTTP 401 as retryable.
  if (
    input.status === 401
    || code === 'provider_auth_failed'
    || code === 'invalid_api_key'
    || code === 'policy_denied'
    || /\bvllm error 401\b|\bcortex error 401\b|\berror 401\b/i.test(blob)
    || /auth_failed|invalid_api_key|incorrect api key|permission_denied|policy_denied|credentials were not provided|token_not_valid|malformed jwt/i.test(blob)
  ) {
    return false;
  }

  // Honor explicit retryable only after hard non-transient gates above.
  if (input.retryable === true) return true;
  if (input.retryable === false) return false;

  if (input.status != null && (input.status === 429 || input.status >= 500)) return true;
  // Numeric 5xx arriving as a CODE (Cortex SSE error frames carry code: 500
  // with no HTTP status — shizuha2 2026-08-10: 'EngineCore encountered an
  // issue (code: 500)' was not classified transient and killed the turn).
  const numericCode = Number(code);
  if (Number.isFinite(numericCode) && (numericCode === 429 || numericCode >= 500)) return true;
  if (/enginecore|engine.?dead|engine encountered/i.test(blob)) return true;

  return (
    code === 'server_error'
    || code === 'internal_error'
    || code === 'provider_5xx'
    || code === 'provider_error'
    || code === 'etimedout'
    || code === 'econnreset'
    || code === 'epipe'
    || type === 'server_error'
    || type === 'timeout_error'
    || /server_error|internal_error|provider_5xx/i.test(blob)
    || /timed?\s*out|timeout|stall|overloaded|temporar|unavailable|try again/i.test(blob)
    || /econnreset|socket hang|premature close|fetch failed|other side closed|terminated/i.test(blob)
    || /error occurred while processing|help\.openai\.com|upstream interrupted|stream (closed|interrupted|dropped)/i.test(blob)
    || /rate.?limit|at capacity|no first chunk|non-streaming response timeout/i.test(blob)
  );
}
