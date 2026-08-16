/**
 * Terminal-safe display helpers (SCLI-407 / SCLI-178).
 *
 * Caller-controlled identifiers (session IDs, device IDs, agent selectors,
 * persisted names, CWD paths) must NEVER be rendered byte-for-byte to a
 * terminal/log channel. Raw C0/C1 controls, ANSI ESC sequences, CR, and
 * attacker-supplied LF can forge diagnostics, overwrite lines, or change
 * styling. This module is the single neutralization point so every surface
 * (resume, devices list/revoke, pulse list, help --cwd, up/reseed selectors)
 * renders hostile input as bounded, single-line, inert text.
 *
 * Preserve ordinary international Unicode; neutralize only the control
 * surface (Unicode TR36/TR39, MITRE CWE-451/CWE-117).
 */

/** ASCII C0 controls + DEL, C1 controls, ESC, and common bidi/invisible Unicode. */
const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u0080-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2060\ufeff]/g;

/** Upper bound on a single rendered field, matching the 512-byte diagnostic budget. */
export const MAX_INERT_FIELD = 512;

/**
 * Render a caller-controlled value as a bounded, single-line, terminal-inert
 * string. Control bytes are replaced with printable `\xNN`-style escapes;
 * line breaks collapse to a space so an attacker cannot forge another line.
 *
 * @param value  the untrusted input
 * @param maxLen  per-field presentation bound (default 512)
 */
export function inert(value: unknown, maxLen: number = MAX_INERT_FIELD): string {
  let s = typeof value === 'string' ? value : String(value ?? '');
  if (s.length === 0) return s;
  // Collapse CR/LF/CRLF so no attacker-supplied newline can forge a line.
  s = s.replace(/\r\n?/g, '\n').replace(/\n/g, ' ');
  // Neutralize C0/C1 + bidi/invisible controls as printable escapes.
  s = s.replace(CONTROL_RE, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return `\\x${cp.toString(16).padStart(2, '0')}`;
  });
  if (s.length > maxLen) {
    s = s.slice(0, maxLen - 3) + '...';
  }
  return s;
}

/** True when a value contains no terminal-active control bytes (usable for rejection). */
export function isInert(value: unknown): boolean {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return !CONTROL_RE.test(s) && !/[\r\n]/.test(s);
}
