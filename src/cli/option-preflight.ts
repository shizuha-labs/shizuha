/**
 * Shared semantic preflight for CLI option domains (SCLI-400).
 *
 * Validates documented enums and port grammar **before** any provider, MCP,
 * session, filesystem composition, listener, cron, or heartbeat work.
 * Failures are bounded field/value diagnostics — never raw stacks or bundle paths.
 *
 * Coverage (PLAT-5893 / SCLI-492 / SCLI-418): all optional option domains fail
 * CLOSED on explicit-empty (--opt=) / whitespace-only values instead of treating
 * them as "missing" — this covers --mode/--thinking/--effort/--max-turns/
 * --temperature/--sandbox/--port, channel modes (--discord-mode/--slack-mode:
 * mention|dm|all), --host (non-empty, no whitespace), webhook ports
 * (--line-webhook-port/--whatsapp-webhook-port/--imessage-webhook-port: 1-65535),
 * and --context-prompt-file (non-empty; rejects FIFO/non-regular so open() can
 * never block). Entrypoints that route here: root, exec, pipe, gateway, serve,
 * claude-bridge, codex-bridge, openclaw-bridge, antigravity-bridge, resume.
 */

import { statSync as fsStatSync } from 'node:fs';
import { isIP } from 'node:net';
import { BUILTIN_TOOLSETS } from '../tools/toolsets.js';
import { assertWorkspaceDir } from '../utils/fs.js';

export const PERMISSION_MODES = ['plan', 'supervised', 'autonomous'] as const;
export type PermissionModeOpt = (typeof PERMISSION_MODES)[number];

/** Canonical toolset names (single source of truth: tools/toolsets.ts). */
export const TOOLSETS = Object.keys(BUILTIN_TOOLSETS).sort() as readonly string[];
export type ToolsetOpt = (typeof TOOLSETS)[number];

/** Gateway/Claude thinking domain (union of help surfaces). */
export const THINKING_LEVELS = ['off', 'on', 'low', 'medium', 'high'] as const;
export type ThinkingLevelOpt = (typeof THINKING_LEVELS)[number];

// 'ultra'/'max' are gpt-5.6-sol ChatGPT-backend reasoning levels (auto task
// delegation) that the codex-bridge app-server forwards raw to the backend
// (see normalizeReasoningEffort in provider/codex.ts). They must pass CLI
// preflight so Hive's reasoning_effort=ultra/max does not wedge the bridge
// with "Invalid --effort"; the Responses-API path clamps them to xhigh.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const;
export type EffortLevelOpt = (typeof EFFORT_LEVELS)[number];

export const SANDBOX_MODES = [
  'unrestricted',
  'read-only',
  'workspace-write',
  'external',
] as const;

export class OptionPreflightError extends Error {
  readonly field: string;
  readonly value: string;
  readonly code = 'invalid_option';

  constructor(field: string, value: string, detail: string) {
    super(detail);
    this.name = 'OptionPreflightError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Shared --cwd validation leg (SCLI-529/SCLI-558/SCLI-796). Runs the
 * assertWorkspaceDir contract and wraps failures as OptionPreflightError so
 * every call site — action-path preflight AND the commander help-exit catch —
 * emits the identical field-specific diagnostic. Undefined/null (option not
 * supplied) passes through as undefined.
 */
export function validateCwdOption(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const rawCwd = String(value);
  try {
    return assertWorkspaceDir(rawCwd);
  } catch (err) {
    throw new OptionPreflightError(
      'cwd',
      rawCwd,
      err instanceof Error ? err.message : '--cwd must be an existing directory',
    );
  }
}

export function requireEnum(
  field: string,
  value: unknown,
  allowed: readonly string[],
  optional = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new OptionPreflightError(field, '', `Missing required option --${field}`);
  }
  const raw = String(value);
  if (!allowed.includes(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected one of: ${allowed.join(', ')}`,
    );
  }
  return raw;
}

/**
 * Optional enum that must be non-empty WHEN present (SCLI-492 / SCLI-418).
 *
 * Unlike `requireEnum(..., optional=true)` — which treats an explicit
 * `--opt=` (empty string) as "missing" and silently accepts it — this fails
 * closed on explicit-empty/whitespace values so a templated launcher can never
 * silently discard a requested domain value. Absent/undefined stays optional.
 */
export function requireOptionalEnumNonEmpty(
  field: string,
  value: unknown,
  allowed: readonly string[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value);
  if (raw.trim() === '') {
    throw new OptionPreflightError(
      field,
      '',
      `Invalid --${field} ${JSON.stringify('')}; expected one of: ${allowed.join(', ')}`,
    );
  }
  if (!allowed.includes(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected one of: ${allowed.join(', ')}`,
    );
  }
  return raw;
}

/**
 * Optional scalar that must be non-empty WHEN present (SCLI-492).
 *
 * Rejects explicit-empty/whitespace-only values so an optional option can
 * never silently lose its value. Absent/undefined stays optional; the caller
 * runs the domain grammar (int/port/enum) after this gate.
 */
export function requireOptionalNonEmpty(
  field: string,
  value: unknown,
): unknown {
  if (value === undefined || value === null) return value;
  const raw = String(value);
  if (raw.trim() === '') {
    throw new OptionPreflightError(
      field,
      '',
      `Invalid --${field} ${JSON.stringify('')}; expected a non-empty value`,
    );
  }
  return value;
}

/** Discord/Slack respond-mode domain. */
export const CHANNEL_MODES = ['mention', 'dm', 'all'] as const;
export type ChannelModeOpt = (typeof CHANNEL_MODES)[number];

/** Maximum accepted length for a --model selector (SCLI-564). */
export const MODEL_MAX_LENGTH = 2048;

/**
 * Optional --model selector that must be semantically valid WHEN present
 * (SCLI-564). A model selector is an authority/routing input written into
 * startup summaries and provider/client construction, so an invalid explicit
 * value must fail preflight BEFORE any auth, state write, provider/client
 * construction, listener binding, or startup logging.
 *
 * Rejects: explicit-empty/whitespace-only, whitespace/control-bearing (space,
 * TAB, LF, ESC, DEL, Unicode em-space), and over-limit (>2048) values. Absent/
 * undefined stays optional. The diagnostic never reflects raw control bytes.
 */
export function requireOptionalModel(
  field: string,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value);
  if (raw.trim() === '') {
    throw new OptionPreflightError(
      field,
      '',
      `Invalid --${field} ${JSON.stringify('')}; expected a non-empty model selector`,
    );
  }
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new OptionPreflightError(
      field,
      '',
      `Invalid --${field}: model selector must not contain whitespace or control characters`,
    );
  }
  if (raw.length > MODEL_MAX_LENGTH) {
    throw new OptionPreflightError(
      field,
      '',
      `Invalid --${field}: exceeds ${MODEL_MAX_LENGTH} characters`,
    );
  }
  return raw;
}

/**
 * Canonical decimal TCP port in 1..65535.
 * Rejects non-decimal junk suffixes, negatives, zero, and >65535.
 */
export function requirePort(
  field: string,
  value: unknown,
  optional = false,
): number | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new OptionPreflightError(field, '', `Missing required option --${field}`);
  }
  if (String(value).trim() === '') {
    throw new OptionPreflightError(
      field,
      '',
      `Invalid --${field} ${JSON.stringify('')}; expected an integer port 1-65535`,
    );
  }
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected an integer port 1-65535`,
    );
  }
  if (raw.length > 1 && raw.startsWith('0')) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected an integer port 1-65535`,
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected an integer port 1-65535`,
    );
  }
  return n;
}

/**
 * Bind-host grammar (SCLI-555): accepts only a bounded hostname/IP/address
 * compatible with the listener API. Rejects empty, whitespace/control,
 * path-like (`../tmp/socket`), URL-like (`http://127.0.0.1`), overlong
 * (>= 2048-byte hostname), and any character outside the hostname/IP charset —
 * BEFORE any session/auth/skill/child/metrics/listener work so the failure is
 * a bounded `--host` diagnostic, never a raw Node DNS/bind stack.
 */
export function requireBindHost(field: string, value: unknown): string {
  const raw = String(value ?? '');
  if (raw.trim() === '') {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a non-empty host/address`,
    );
  }
  if (/[\s\u0000-\u001f]/.test(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a host/address with no whitespace/control characters`,
    );
  }
  if (raw.length > 255) {
    throw new OptionPreflightError(
      field,
      raw,
      // Wording note (SCLI-555 rebase): must not contain the substring "at " —
      // the SCLI-566 bounded-diagnostic assertion forbids /at / to exclude raw
      // stack lines ("at fn (...)"), and "at most" tripped it (run 6781).
      `Invalid --${field} ${JSON.stringify(raw.length > 64 ? `${raw.slice(0, 64)}…` : raw)}; host/address exceeds the 255-character limit`,
    );
  }
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a hostname/IP address, not a path`,
    );
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a hostname/IP address, not a URL`,
    );
  }
  if (!/^[A-Za-z0-9.:\[\]-]+$/.test(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a hostname/IP address (letters, digits, '.', ':', '-', '[', ']')`,
    );
  }
  return raw;
}

export function requireNonNegativeInt(
  field: string,
  value: unknown,
  optional = false,
): number | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new OptionPreflightError(field, '', `Missing required option --${field}`);
  }
  if (String(value).trim() === '') {
    throw new OptionPreflightError(
      field,
      '',
      `Invalid --${field} ${JSON.stringify('')}; expected a non-negative integer`,
    );
  }
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a non-negative integer`,
    );
  }
  return Number(raw);
}

export function requireFiniteNumber(
  field: string,
  value: unknown,
  opts: { optional?: boolean; min?: number; max?: number } = {},
): number | undefined {
  const optional = opts.optional === true;
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new OptionPreflightError(field, '', `Missing required option --${field}`);
  }
  if (String(value).trim() === '') {
    throw new OptionPreflightError(
      field,
      '',
      `Invalid --${field} ${JSON.stringify('')}; expected a number`,
    );
  }
  const raw = String(value).trim();
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a number`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a finite number`,
    );
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; minimum is ${opts.min}`,
    );
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; maximum is ${opts.max}`,
    );
  }
  return n;
}

/**
 * Canonical bind host for a listener (SCLI-566).
 *
 * Rejects pre-init, before any DNS/socket/bind work:
 *  - explicit-empty / whitespace / control-bearing values (never an
 *    empty-host listener bind),
 *  - malformed values (path separators, bare colons, brackets, oversized),
 *  - syntactically invalid IP/hostname values,
 *  - and — for a syntactically valid hostname that does not resolve — a
 *    bounded diagnostic instead of a raw `node:dns` getaddrinfo stack.
 *
 * A valid explicit IP or resolvable hostname passes through unchanged.
 */
export function requireHost(field: string, value: unknown, optional = false): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new OptionPreflightError(field, '', `Missing required option --${field}`);
  }
  const raw = String(value);
  if (raw.trim() === '' || /[\s\u0000-\u001f]/.test(raw)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a non-empty host/address with no whitespace/control characters`,
    );
  }
  if (raw.length > 253) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; host/address exceeds 253 characters`,
    );
  }
  // Path separators and bare colons (outside a bracketed IPv6 literal) are
  // never valid listener hosts.
  if (raw.includes('/')) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a host/address, not a path`,
    );
  }
  const bracketedIpv6 = /^\[[0-9a-fA-F:.]+\]$/.test(raw);
  if (!bracketedIpv6 && raw.includes(':')) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a host/address (IPv6 must be bracketed)`,
    );
  }
  if (raw.includes('[') || raw.includes(']')) {
    if (!bracketedIpv6) {
      throw new OptionPreflightError(
        field,
        raw,
        `Invalid --${field} ${JSON.stringify(raw)}; unexpected brackets in host/address`,
      );
    }
  }

  // Strip brackets for an IPv6 literal.
  const candidate = bracketedIpv6 ? raw.slice(1, -1) : raw;
  if (isIP(candidate) !== 0) {
    return raw; // Valid IPv4/IPv6 literal — no DNS needed.
  }

  // Hostname grammar: dot-separated labels of letters/digits/hyphens, each
  // 1-63 chars, not starting/ending with a hyphen.
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(candidate)) {
    throw new OptionPreflightError(
      field,
      raw,
      `Invalid --${field} ${JSON.stringify(raw)}; expected a valid hostname or IP address`,
    );
  }

  // A syntactically valid hostname that does not resolve is caught at the
  // listener boundary (server.ts) and converted to a bounded diagnostic —
  // never a raw `node:dns` getaddrinfo stack. No DNS work happens here:
  // this preflight is purely syntactic, before any DNS/socket/bind work.
  return raw;
}

export interface CommonAgentOpts {
  mode?: unknown;
  thinking?: unknown;
  effort?: unknown;
  port?: unknown;
  maxTurns?: unknown;
  temperature?: unknown;
  sandbox?: unknown;
  /** When true, mode is optional if unset. */
  optionalEnums?: boolean;
  /** Validate port when present / required. */
  requirePortField?: boolean;
  /** Optional webhook ports (validated 1-65535 when present/non-empty). */
  lineWebhookPort?: unknown;
  whatsappWebhookPort?: unknown;
  imessageWebhookPort?: unknown;
  /** Optional Discord/Slack respond-mode enums (mention|dm|all). */
  discordMode?: unknown;
  slackMode?: unknown;
  /** Optional bind host — non-empty, no whitespace/control (rejects --host=). */
  host?: unknown;
  /** Optional context-prompt file path — non-empty, not a FIFO. */
  contextPromptFile?: unknown;
  /** Optional toolset name — canonical list only (rejects unknown/case/empty). */
  toolset?: unknown;
  /** Optional working directory — when present it must resolve to a directory. */
  cwd?: unknown;
  /** Optional --model selector — non-empty, no whitespace/control, bounded (SCLI-564). */
  model?: unknown;
  /** Optional inline context prompt — non-empty, no control chars, bounded length. */
  contextPrompt?: unknown;
}

export function validateCommonAgentOptions(opts: CommonAgentOpts): {
  mode?: PermissionModeOpt;
  thinking?: ThinkingLevelOpt;
  effort?: EffortLevelOpt;
  port?: number;
  maxTurns?: number;
  temperature?: number;
  sandbox?: string;
  lineWebhookPort?: number;
  whatsappWebhookPort?: number;
  imessageWebhookPort?: number;
  discordMode?: ChannelModeOpt;
  slackMode?: ChannelModeOpt;
  host?: string;
  contextPromptFile?: string;
  toolset?: ToolsetOpt;
  cwd?: string;
  model?: string;
  contextPrompt?: string;
} {
  // SCLI-492/SCLI-418: optional enums fail CLOSED on explicit-empty/whitespace.
  const modeOptional = opts.optionalEnums === true || opts.mode === undefined;
  const mode = (
    modeOptional
      ? requireOptionalEnumNonEmpty('mode', opts.mode, PERMISSION_MODES)
      : requireEnum('mode', opts.mode, PERMISSION_MODES)
  ) as PermissionModeOpt | undefined;

  const thinking = requireOptionalEnumNonEmpty('thinking', opts.thinking, THINKING_LEVELS) as
    | ThinkingLevelOpt
    | undefined;

  const effort = requireOptionalEnumNonEmpty('effort', opts.effort, EFFORT_LEVELS) as
    | EffortLevelOpt
    | undefined;

  const discordMode = requireOptionalEnumNonEmpty('discord-mode', opts.discordMode, CHANNEL_MODES) as
    | ChannelModeOpt
    | undefined;

  const slackMode = requireOptionalEnumNonEmpty('slack-mode', opts.slackMode, CHANNEL_MODES) as
    | ChannelModeOpt
    | undefined;

  let port: number | undefined;
  if (opts.requirePortField || (opts.port !== undefined && opts.port !== null)) {
    port = requirePort('port', opts.port, !opts.requirePortField);
  }

  let maxTurns: number | undefined;
  if (opts.maxTurns !== undefined && opts.maxTurns !== null) {
    maxTurns = requireNonNegativeInt('max-turns', opts.maxTurns);
  }

  let temperature: number | undefined;
  if (opts.temperature !== undefined && opts.temperature !== null) {
    temperature = requireFiniteNumber('temperature', opts.temperature, { min: 0, max: 2 });
  }

  let sandbox: string | undefined;
  if (opts.sandbox !== undefined && opts.sandbox !== null) {
    sandbox = requireOptionalEnumNonEmpty('sandbox', opts.sandbox, SANDBOX_MODES);
  }

  const toolset = requireOptionalEnumNonEmpty('toolset', opts.toolset, TOOLSETS) as
    | ToolsetOpt
    | undefined;

  // Optional webhook ports: absent OR valid 1-65535; empty/whitespace/junk reject.
  const lineWebhookPort = opts.lineWebhookPort !== undefined && opts.lineWebhookPort !== null
    ? requirePort('line-webhook-port', opts.lineWebhookPort)
    : undefined;
  const whatsappWebhookPort = opts.whatsappWebhookPort !== undefined && opts.whatsappWebhookPort !== null
    ? requirePort('whatsapp-webhook-port', opts.whatsappWebhookPort)
    : undefined;
  const imessageWebhookPort = opts.imessageWebhookPort !== undefined && opts.imessageWebhookPort !== null
    ? requirePort('imessage-webhook-port', opts.imessageWebhookPort)
    : undefined;

  // Optional bind host: bounded hostname/IP/address grammar (SCLI-555).
  // Rejects empty, whitespace/control, path-like, URL-like, overlong, and
  // out-of-charset values before any listener/DNS work. Supersedes the
  // earlier requireHost bind-host check (SCLI-566 lineage): requireBindHost
  // is a strict superset of its rejections.
  let host: string | undefined;
  if (opts.host !== undefined && opts.host !== null) {
    host = requireBindHost('host', opts.host);
  }

  // Optional context-prompt file: non-empty path; reject FIFOs (they would
  // block open() forever) and non-regular files up front.
  let contextPromptFile: string | undefined;
  if (opts.contextPromptFile !== undefined && opts.contextPromptFile !== null) {
    const rawFile = String(opts.contextPromptFile);
    if (rawFile.trim() === '') {
      throw new OptionPreflightError(
        'context-prompt-file',
        '',
        `Invalid --context-prompt-file ${JSON.stringify('')}; expected a readable file path`,
      );
    }
    let st;
    try {
      st = fsStatSync(rawFile);
    } catch {
      throw new OptionPreflightError(
        'context-prompt-file',
        rawFile,
        `Invalid --context-prompt-file ${JSON.stringify(rawFile)}; expected a readable file path`,
      );
    }
    if (!st.isFile()) {
      throw new OptionPreflightError(
        'context-prompt-file',
        rawFile,
        `Invalid --context-prompt-file ${JSON.stringify(rawFile)}; expected a regular file (got ${st.isDirectory() ? 'a directory' : 'not a regular file'})`,
      );
    }
    contextPromptFile = rawFile;
  }

  // Optional workspace directory. Bridge actions pass their effective default
  // explicitly, so invalid cwd values fail before metrics/session/gateway work.
  let cwd: string | undefined;
  if (opts.cwd !== undefined && opts.cwd !== null) {
    cwd = validateCwdOption(opts.cwd);
  }

  // Optional model selector: non-empty, no whitespace/control/newline. SCLI-588:
  // a malformed --model must fail locally and finitely BEFORE any session
  // creation, provider dispatch, or durable state mutation — never hang trying
  // to pull a garbage selector or create state.db for it.
  let model: string | undefined;
  if (opts.model !== undefined && opts.model !== null) {
    const rawModel = String(opts.model);
    if (rawModel.trim() === '' || /[\s\u0000-\u001f\u007f]/.test(rawModel)) {
      throw new OptionPreflightError(
        'model',
        rawModel,
        `Invalid --model ${JSON.stringify(rawModel)}; expected a non-empty model selector with no whitespace or control characters`,
      );
    }
    model = rawModel;
  }

  // Optional inline context prompt (SCLI-547): reject explicit-empty/blank,
  // control-bearing (ANSI escape, embedded LF/TAB, DEL), and over-limit values
  // BEFORE any filesystem/child-process/listener/runtime work. The context
  // prompt is written into workspace instruction files (AGENTS.md etc.), so a
  // malformed payload is an instruction-file trust boundary — it must never
  // reach a write. Multi-line prompts go through --context-prompt-file, which
  // is validated separately (non-empty, regular file).
  let contextPrompt: string | undefined;
  if (opts.contextPrompt !== undefined && opts.contextPrompt !== null) {
    const rawPrompt = String(opts.contextPrompt);
    if (rawPrompt.trim() === '') {
      throw new OptionPreflightError(
        'context-prompt',
        '',
        `Invalid --context-prompt ${JSON.stringify('')}; expected a non-empty prompt`,
      );
    }
    if (/[\u0000-\u001f\u007f]/.test(rawPrompt)) {
      throw new OptionPreflightError(
        'context-prompt',
        rawPrompt,
        `Invalid --context-prompt: control characters are not allowed (use --context-prompt-file for multi-line prompts)`,
      );
    }
    if (rawPrompt.length > 4096) {
      throw new OptionPreflightError(
        'context-prompt',
        rawPrompt,
        `Invalid --context-prompt: exceeds 4096 characters (use --context-prompt-file for larger prompts)`,
      );
    }
    contextPrompt = rawPrompt;
  }

  return {
    mode, thinking, effort, port, maxTurns, temperature, sandbox,
    lineWebhookPort, whatsappWebhookPort, imessageWebhookPort,
    discordMode, slackMode, host, contextPromptFile, toolset, cwd, contextPrompt,
    model: requireOptionalModel('model', opts.model),
  };
}

/** Print one bounded diagnostic and exit nonzero. Never dumps stacks/paths. */
export function exitOnOptionPreflightError(err: unknown): never {
  if (err instanceof OptionPreflightError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

/** Run validate + exit helper for command actions. */
export function preflightOrExit(opts: CommonAgentOpts): ReturnType<typeof validateCommonAgentOptions> {
  try {
    return validateCommonAgentOptions(opts);
  } catch (err) {
    exitOnOptionPreflightError(err);
  }
}
