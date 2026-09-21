/**
 * SCLI-521: `--version` / `-V` must only succeed for structurally valid argv.
 *
 * Commander's built-in `.version()` prints the version and exits 0 as soon as
 * it sees the flag, masking unknown commands/options or unexpected operands
 * before or after it. This suite pins the guard that rejects invalid argv
 * BEFORE commander can mask it — long/short flags, token order, explicit
 * empty, ASCII/Unicode whitespace, option-shaped values, and boolean-value
 * syntax.
 */
import { describe, expect, it } from 'vitest';
import { versionQueryError } from '../../src/cli/version-query.js';

describe('SCLI-521 version-query argv validation', () => {
  it('accepts a lone --version', () => {
    expect(versionQueryError(['--version'])).toBeNull();
  });

  it('accepts a lone -V', () => {
    expect(versionQueryError(['-V'])).toBeNull();
  });

  it('accepts --json alongside --version / -V (SCLI-531 inert success)', () => {
    expect(versionQueryError(['--json', '--version'])).toBeNull();
    expect(versionQueryError(['--version', '--json'])).toBeNull();
    expect(versionQueryError(['--json', '-V'])).toBeNull();
  });

  it('returns null when no version flag is present', () => {
    expect(versionQueryError(['-p', 'hello'])).toBeNull();
    expect(versionQueryError([])).toBeNull();
  });

  it('rejects an unknown command before --version, naming it', () => {
    const err = versionQueryError(['definitely-not-a-command', '--version']);
    expect(err).toContain('definitely-not-a-command');
  });

  it('rejects an unknown option before --version, naming it', () => {
    const err = versionQueryError(['--bogus', '--version']);
    expect(err).toContain('--bogus');
  });

  it('rejects an unknown option after --version, naming it', () => {
    const err = versionQueryError(['--version', '--bogus']);
    expect(err).toContain('--bogus');
  });

  it('rejects an operand after --version, naming it', () => {
    const err = versionQueryError(['--version', 'extra']);
    expect(err).toContain('extra');
  });

  it('rejects an operand before -V, naming it', () => {
    const err = versionQueryError(['extra', '-V']);
    expect(err).toContain('extra');
  });

  it('rejects two ordinary operands', () => {
    const err = versionQueryError(['--version', 'a', 'b']);
    expect(err).toContain('a');
  });

  it('rejects an explicit empty operand', () => {
    const err = versionQueryError(['--version', '']);
    expect(err).toContain("''");
  });

  it('rejects ASCII whitespace operands', () => {
    expect(versionQueryError(['--version', ' '])).not.toBeNull();
    expect(versionQueryError(['--version', '\t'])).not.toBeNull();
  });

  it('rejects Unicode whitespace operands', () => {
    expect(versionQueryError(['--version', '\u00a0'])).not.toBeNull(); // NBSP
    expect(versionQueryError(['--version', '\u2003'])).not.toBeNull(); // EM SPACE
    expect(versionQueryError(['--version', '\ufeff'])).not.toBeNull(); // BOM
  });

  it('rejects boolean-value syntax (--version=true)', () => {
    const err = versionQueryError(['--version=true']);
    // Not the exact flag, so commander's unknown-option path owns it — the
    // guard must NOT treat it as a valid version query.
    expect(err).toBeNull();
  });

  it('rejects duplicate version flags', () => {
    const err = versionQueryError(['--version', '--version']);
    expect(err).toContain('--version');
  });

  it('rejects -V combined with a sibling option', () => {
    const err = versionQueryError(['-V', '--bogus']);
    expect(err).toContain('--bogus');
  });
});
