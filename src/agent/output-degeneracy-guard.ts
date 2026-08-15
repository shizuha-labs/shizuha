export interface OutputDegeneracyVerdict {
  degenerate: boolean;
  reason?: 'repeated_action_chatter' | 'repeated_line' | 'script_collapse';
  evidence?: string;
}

const ACTION_PREFACE = /^(?:(?:now|next|then)\s+)?(?:let me|i(?:'ll| will| need to))\b/i;

/** Matches the diagnostic SCLI writes when the chatter guard trips. */
export const DEGENERACY_STOP_NOTICE_RE =
  /^\[Generation stopped by SCLI: repetitive planning output\b/i;

/** Fixed recovery prompt injected after a chatter stop (exact-match sanitized). */
export const DEGENERACY_RECOVERY_PROMPT =
  'SCLI stopped your previous response because it was repeating planning chatter without a tool call. Do not restate plans. Call exactly one concrete tool for the next step now, or give the final answer if the work is already complete.';

function normalizeLine(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/[`*_>#]/g, '')
    .replace(/[^a-z0-9/_. -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. -]+$/g, '');
}

/**
 * Detect a model narrating the same intended action indefinitely without ever
 * producing a tool call. This is deliberately narrow: prose, lists, code, and
 * repeated log lines are not enough; the recent output must be dominated by
 * first-person action prefaces such as "Let me edit" / "I'll run".
 */
export function messagesHaveRecentToolWork(
  messages: Array<{ role?: string; content?: unknown }>,
  lookback = 16,
): boolean {
  const start = Math.max(0, messages.length - lookback);
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (!message || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const type = (block as { type?: string }).type;
      if (type === 'tool_result' || type === 'tool_use') return true;
    }
  }
  return false;
}

const SCRIPT_LATIN = /[A-Za-z]/g;
const SCRIPT_CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g;
const SCRIPT_CYRILLIC = /[\u0400-\u04ff]/g;
const SCRIPT_HANGUL = /[\uac00-\ud7af]/g;
const SCRIPT_ARABIC = /[\u0600-\u06ff]/g;

function countMatches(re: RegExp, text: string): number {
  const hits = text.match(re);
  return hits ? hits.length : 0;
}

/**
 * shizuha1 2026-08-13: after a long DeepSeek turn the content channel became
 * mixed CJK/Cyrillic/Hangul/Latin token soup. That is never a valid next
 * action — cut even on a working turn (unlike "let me patch now").
 * Legitimate ja/zh comments in code stay on 1–2 scripts and do not trip.
 */
export function detectScriptCollapse(output: string): OutputDegeneracyVerdict {
  const tail = output.slice(-800);
  if (tail.length < 160) return { degenerate: false };
  const counts = {
    latin: countMatches(SCRIPT_LATIN, tail),
    cjk: countMatches(SCRIPT_CJK, tail),
    cyrillic: countMatches(SCRIPT_CYRILLIC, tail),
    hangul: countMatches(SCRIPT_HANGUL, tail),
    arabic: countMatches(SCRIPT_ARABIC, tail),
  };
  const present = Object.entries(counts).filter(([, n]) => n >= 12);
  if (present.length < 3) return { degenerate: false };
  const letters = present.reduce((sum, [, n]) => sum + n, 0);
  const nonLatin = letters - counts.latin;
  if (letters < 80 || nonLatin / letters < 0.20) return { degenerate: false };
  return {
    degenerate: true,
    reason: 'script_collapse',
    evidence: present.map(([name, n]) => `${name}:${n}`).join(' '),
  };
}

export function detectOutputDegeneracy(
  output: string,
  opts?: { midStream?: boolean; workingTurn?: boolean },
): OutputDegeneracyVerdict {
  if (output.length < 180) return { degenerate: false };

  // CTX-649: mid-stream, a "Let me..."-wall is more often leaked REASONING
  // (engine separation miss) than a genuine spin — and killing early drops
  // the tool call that was coming. Demand 3x the window before cutting a
  // stream that is still producing.
  //
  // Operator 2026-08-13 (shizuha5): "let me *" is not wrong while the agent
  // is working. After tools this turn, apply the same 3x bar at FINAL —
  // a concrete next step ("let me write views.py") must not stop the turn.
  // Mid-stream + workingTurn still uses this 3x bar (not a full skip).
  // 2026-08-13 18:58Z shizuha5: after tools, the model painted 151×
  // "let me run it" because turn.ts skipped mid-stream entirely.
  const strict = Boolean(opts?.midStream || opts?.workingTurn);
  const windowLines = strict ? 60 : 20;
  const tail = output.slice(strict ? -48_000 : -16_000);
  const lines = tail
    .split(/\r?\n+/)
    .map(normalizeLine)
    .filter((line) => line.length >= 3 && line.length <= 240)
    .slice(-windowLines);
  if (lines.length < (strict ? 24 : 7)) return { degenerate: false };

  const actionLines = lines.filter((line) => ACTION_PREFACE.test(line));
  const recent = lines.slice(-(strict ? 36 : 12));
  const recentActionLines = recent.filter((line) => ACTION_PREFACE.test(line));
  const needTotal = strict ? 30 : 10;
  const needRecent = strict ? 27 : 9;
  if (actionLines.length >= needTotal && recentActionLines.length >= needRecent) {
    return {
      degenerate: true,
      reason: 'repeated_action_chatter',
      evidence: recentActionLines.slice(-3).join(' | '),
    };
  }

  const counts = new Map<string, number>();
  for (const line of actionLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const mostRepeated = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  // Identical-line floor: 4 was a false positive on DeepSeek restating one
  // next action ("let me write views.py") before the tool invoke. A real
  // spin repeats the same line many times; 8/10 still catch that.
  const repeatFloor = strict ? 10 : 8;
  const actionFloor = strict ? 21 : 8;
  if (
    mostRepeated
    && mostRepeated[1] >= repeatFloor
    && actionLines.length >= actionFloor
    && mostRepeated[1] * 2 >= actionLines.length
  ) {
    return {
      degenerate: true,
      reason: 'repeated_line',
      evidence: `${mostRepeated[0]} (×${mostRepeated[1]})`,
    };
  }

  return { degenerate: false };
}

/** Operator-facing stop notice — includes evidence so a true spin is not mistaken for a 2-line false positive. */
export function formatDegeneracyStopNotice(reason: string, evidence?: string): string {
  const evidencePart = evidence?.trim()
    ? ` Evidence (last action lines): "${evidence.trim().slice(0, 220)}".`
    : '';
  return (
    `[Generation stopped by SCLI: repetitive planning output (${reason}).${evidencePart} ` +
    `This response segment produced no tool call (earlier tool results in the turn are preserved). ` +
    `State one concrete next action and call the tool — do not restate the plan.]`
  );
}

export function isDegeneracyStopNotice(text: string): boolean {
  return DEGENERACY_STOP_NOTICE_RE.test(text.trim());
}
