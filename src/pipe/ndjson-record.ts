/**
 * NDJSON record validation for `shizuha pipe` (SCLI-399).
 *
 * Every nonblank stdin line is decoded and schema-checked before any field
 * access. Invalid values never throw; callers emit a bounded error and keep
 * reading the next line so the warm-pool process stays alive.
 */

export type PipeInvalidKind =
  | 'malformed_json'
  | 'null'
  | 'array'
  | 'scalar'
  | 'not_object'
  | 'not_user'
  | 'missing_content';

export interface PipeValidUserRecord {
  ok: true;
  /** Original decoded object (type === 'user'). */
  msg: Record<string, unknown>;
  userContent: string;
  incomingSessionId: string;
}

export interface PipeInvalidRecord {
  ok: false;
  kind: PipeInvalidKind;
  /** Short, machine-safe reason (no paths, no stacks). */
  error: string;
}

export type PipeRecordResult = PipeValidUserRecord | PipeInvalidRecord;

/** Max nonblank line length accepted before rejecting as malformed framing. */
export const PIPE_MAX_LINE_BYTES = 256 * 1024;

/**
 * Classify one stdin line. Blank/whitespace-only lines return `null` (skip
 * silently — preserves empty/blank EOF behavior).
 */
export function classifyPipeLine(line: string): PipeRecordResult | null {
  // Preserve empty / blank-line controls: no event, no error.
  if (line.length === 0 || /^\s*$/.test(line)) {
    return null;
  }

  if (Buffer.byteLength(line, 'utf8') > PIPE_MAX_LINE_BYTES) {
    return {
      ok: false,
      kind: 'malformed_json',
      error: `NDJSON record exceeds ${PIPE_MAX_LINE_BYTES} bytes`,
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return {
      ok: false,
      kind: 'malformed_json',
      error: 'NDJSON record is not valid JSON',
    };
  }

  return validateDecodedPipeRecord(decoded);
}

export function validateDecodedPipeRecord(decoded: unknown): PipeRecordResult {
  if (decoded === null) {
    return { ok: false, kind: 'null', error: 'NDJSON record must be a user message object, got null' };
  }
  if (Array.isArray(decoded)) {
    return { ok: false, kind: 'array', error: 'NDJSON record must be a user message object, got array' };
  }
  const t = typeof decoded;
  if (t !== 'object') {
    return {
      ok: false,
      kind: 'scalar',
      error: `NDJSON record must be a user message object, got ${t}`,
    };
  }

  // Reject exotic objects (e.g. decoded as non-plain via prototype tricks is
  // still a plain Object from JSON.parse — treat missing type/content as invalid).
  const msg = decoded as Record<string, unknown>;
  if (msg.type !== 'user') {
    const got = msg.type === undefined ? 'missing type' : `type=${JSON.stringify(msg.type)}`;
    return {
      ok: false,
      kind: 'not_user',
      error: `NDJSON record must have type "user" (${got})`,
    };
  }

  const message = msg.message;
  let userContent: string | undefined;
  if (typeof message === 'string') {
    userContent = message;
  } else if (message && typeof message === 'object' && !Array.isArray(message)) {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') {
      userContent = content;
    }
  }

  if (!userContent || !userContent.trim()) {
    return {
      ok: false,
      kind: 'missing_content',
      error: 'NDJSON user record missing non-empty message.content',
    };
  }

  const incomingSessionId =
    (typeof msg.session_id === 'string' ? msg.session_id : undefined)
    ?? (typeof msg.sessionId === 'string' ? msg.sessionId : undefined)
    ?? '';

  return {
    ok: true,
    msg,
    userContent,
    incomingSessionId,
  };
}

/** Bounded stdout/stderr payload — never includes paths or stacks. */
export function invalidRecordEvent(result: PipeInvalidRecord, lineNumber: number): Record<string, unknown> {
  return {
    type: 'error',
    subtype: 'invalid_record',
    error: result.error,
    kind: result.kind,
    line: lineNumber,
  };
}
