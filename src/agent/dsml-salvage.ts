/**
 * DSML / tool-markup salvage (2026-08-10, shizuha5 on the DSpark lane;
 * 2026-08-12: bare-invoke form observed on non-DSpark i7-a / Kai heartbeats).
 *
 * DeepSeek's tool-call wire format (`<｜DSML｜tool_calls>` /
 * `<｜DSML｜invoke name="X">` / `<｜DSML｜parameter name="k">`) is normally
 * intercepted by the engine's `--tool-call-parser deepseek_v4` and surfaced as
 * structured `tool_calls` deltas. Under speculative decoding (and on some
 * non-DSpark serving images) the model can emit the TEXT form of those special
 * tokens — or a degraded bare XML form without the DSML token prefix:
 *   `<invoke name="mcp__…__pulse_get_my_alerts"><parameter name="limit">20</parameter></invoke>`
 * The engine parser (token-id / structural-tag based) then passes them through
 * as content. The harness faces two failures: the intended tool never runs,
 * and the raw markup poisons the transcript.
 *
 * This module recovers the intended calls from leaked markup and returns
 * sanitized prose for the transcript. Tolerates:
 *   - fullwidth `｜` and ASCII `|` DSML tags
 *   - bare `<invoke>` / `<parameter>` (no DSML marker) — live Kai 2026-08-12
 */

const BAR = '[｜|]';
const INVOKE_RE = new RegExp(
  `<${BAR}DSML${BAR}invoke\\b[^>]*?name="([^"]+)"[^>]*>([\\s\\S]*?)</${BAR}DSML${BAR}invoke>`,
  'g',
);
const PARAM_RE = new RegExp(
  `<${BAR}DSML${BAR}parameter\\b[^>]*?name="([^"]+)"[^>]*>([\\s\\S]*?)</${BAR}DSML${BAR}parameter>`,
  'g',
);
const ANY_TAG_RE = new RegExp(`</?${BAR}DSML${BAR}[^>]{0,200}>`, 'g');
const MARKER_RE = new RegExp(`${BAR}DSML${BAR}`);

// Bare XML tool markup (parser missed / model degraded away the DSML token).
// Require name="…" so we never treat arbitrary HTML-ish tags as tools.
const BARE_INVOKE_RE =
  /<invoke\b[^>]*?\bname="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g;
const BARE_PARAM_RE =
  /<parameter\b[^>]*?\bname="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
const BARE_MARKER_RE = /<\/?invoke\b|<\/?parameter\b/i;

// Grok / GLM leaked wire form (Ena 2026-08-16): `<tool_call>ToolSearch</tool_call>`
// or `<tool_call>NAME<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`.
const GROK_TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const GROK_ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
const GROK_MARKER_RE = /<\/?tool_call\b/i;

export interface SalvagedDsmlCall {
  name: string;
  input: Record<string, unknown>;
}

export interface DsmlSalvageResult {
  /** True when any DSML / bare-invoke tool markup was present in the text. */
  hadMarkup: boolean;
  /** Tool calls recovered from complete invoke blocks, in order. */
  calls: SalvagedDsmlCall[];
  /** The text with all DSML markup (and salvaged blocks) removed. */
  cleaned: string;
}

function coerceParamValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^(\{|\[|"|-?\d|true$|false$|null$)/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to string */
    }
  }
  return trimmed;
}

function collectParams(body: string, paramRe: RegExp): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  let match: RegExpExecArray | null;
  paramRe.lastIndex = 0;
  while ((match = paramRe.exec(body)) !== null) {
    input[match[1]!] = coerceParamValue(match[2] ?? '');
  }
  return input;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function salvageGrokToolCallInner(inner: string): SalvagedDsmlCall | null {
  const name = (inner.match(/^\s*([^<\s][^<]*?)\s*(?=<arg_key>|$)/)?.[1] ?? '').trim();
  if (!name) return null;
  const input: Record<string, unknown> = {};
  GROK_ARG_RE.lastIndex = 0;
  let arg: RegExpExecArray | null;
  while ((arg = GROK_ARG_RE.exec(inner)) !== null) {
    input[arg[1]!.trim()] = coerceParamValue(arg[2] ?? '');
  }
  return { name, input };
}

export function salvageDsmlToolCalls(text: string): DsmlSalvageResult {
  const source = text ?? '';
  const hasDsml = MARKER_RE.test(source);
  const hasBare = BARE_MARKER_RE.test(source);
  const hasGrok = GROK_MARKER_RE.test(source);
  if (!hasDsml && !hasBare && !hasGrok) {
    return { hadMarkup: false, calls: [], cleaned: source };
  }

  const calls: SalvagedDsmlCall[] = [];
  let cleaned = source;

  if (hasDsml) {
    cleaned = cleaned.replace(INVOKE_RE, (_m, name: string, body: string) => {
      calls.push({ name: name.trim(), input: collectParams(body, PARAM_RE) });
      return ' ';
    });
    cleaned = cleaned.replace(ANY_TAG_RE, ' ');
  }

  if (hasBare) {
    cleaned = cleaned.replace(BARE_INVOKE_RE, (_m, name: string, body: string) => {
      calls.push({ name: name.trim(), input: collectParams(body, BARE_PARAM_RE) });
      return ' ';
    });
    // Stray bare tags (orphans / incomplete blocks) — strip, no invented calls.
    cleaned = cleaned
      .replace(/<\/?invoke\b[^>]{0,200}>/gi, ' ')
      .replace(/<\/?parameter\b[^>]{0,200}>/gi, ' ');
  }

  if (hasGrok) {
    cleaned = cleaned.replace(GROK_TOOL_CALL_RE, (_m, inner: string) => {
      const call = salvageGrokToolCallInner(inner ?? '');
      if (call) calls.push(call);
      return ' ';
    });
    cleaned = cleaned.replace(/<\/?tool_call\b[^>]{0,200}>/gi, ' ');
  }

  return { hadMarkup: true, calls, cleaned: collapseWhitespace(cleaned) };
}

/** Strip DSML / bare-invoke wire markup from text without attempting call
 *  recovery — for healing historical/outbound content where execution is no
 *  longer possible. */
export function stripDsmlMarkup(text: string): string {
  const source = text ?? '';
  if (!MARKER_RE.test(source) && !BARE_MARKER_RE.test(source) && !GROK_MARKER_RE.test(source)) {
    return source;
  }
  return collapseWhitespace(
    source
      .replace(INVOKE_RE, ' ')
      .replace(ANY_TAG_RE, ' ')
      .replace(BARE_INVOKE_RE, ' ')
      .replace(GROK_TOOL_CALL_RE, ' ')
      .replace(/<\/?invoke\b[^>]{0,200}>/gi, ' ')
      .replace(/<\/?parameter\b[^>]{0,200}>/gi, ' ')
      .replace(/<\/?tool_call\b[^>]{0,200}>/gi, ' ')
      .replace(MARKER_RE, ' '),
  );
}

/** CTX-645 / vLLM #40800: DSML start markers split across SSE chunks. */
const STREAM_HOLD_MARKERS = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜toolcalls>',
  '</｜DSML｜tool_calls>',
  '<｜DSML｜invoke',
  '</｜DSML｜invoke>',
  '<｜DSML｜parameter',
  '</｜DSML｜parameter>',
  '<|DSML|tool_calls>',
  '<|DSML|toolcalls>',
  '</|DSML|tool_calls>',
  '<|DSML|invoke',
  '</|DSML|invoke>',
  '<|DSML|parameter',
  '</|DSML|parameter>',
  '<invoke',
  '</invoke>',
  '<parameter',
  '</parameter>',
  '<tool_call',
  '</tool_call>',
];
const STREAM_HOLD_MAX = Math.max(...STREAM_HOLD_MARKERS.map((m) => m.length));

function incompleteMarkerIndex(text: string): number {
  if (!text) return 0;
  const start = Math.max(0, text.length - STREAM_HOLD_MAX);
  for (let i = start; i < text.length; i++) {
    const suf = text.slice(i);
    if (STREAM_HOLD_MARKERS.some((m) => m.startsWith(suf) && suf !== m)) {
      return i;
    }
  }
  return text.length;
}

/**
 * Hold back a streamed tail that could still become a DSML / invoke tag.
 * Complete markup is stripped so the TUI never paints wire form.
 */
export function holdDsmlStreamDelta(
  delta: string,
  carry = '',
  finished = false,
): { text: string; carry: string } {
  let source = (carry || '') + (delta || '');
  if (!source) return { text: '', carry: '' };
  if (MARKER_RE.test(source) || BARE_MARKER_RE.test(source) || GROK_MARKER_RE.test(source)) {
    source = stripDsmlMarkup(source);
  }
  if (finished) return { text: source, carry: '' };
  const cut = incompleteMarkerIndex(source);
  return { text: source.slice(0, cut), carry: source.slice(cut) };
}
