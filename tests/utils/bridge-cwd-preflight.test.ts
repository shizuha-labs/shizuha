import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCodexBridge } from '../../src/codex-bridge/index.js';
import { startOpenClawBridge } from '../../src/openclaw-bridge/index.js';

/**
 * SCLI-493 regression (bridge entrypoints): a bad `--cwd` must be rejected by
 * the shared preflight BEFORE any session/token/telemetry/gateway init — and,
 * critically, BEFORE the bridge constructor runs (the constructor creates a
 * StateStore under the cwd and would raw-crash with a fs stack on a bad path).
 *
 * We call the exported `startXxxBridge` entrypoints with an invalid `--cwd` and
 * assert the rejection is the concise `--cwd` diagnostic, never a raw fs stack.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scli493-entry-'));
const CLEANUPS: string[] = [];

afterEach(() => {
  while (CLEANUPS.length > 0) {
    const p = CLEANUPS.pop();
    if (p) fs.rmSync(p, { recursive: true, force: true });
  }
});

function track(p: string): string {
  CLEANUPS.push(p);
  return p;
}

const BASE_OPTS = {
  port: 0,
  host: '127.0.0.1',
  model: 'gpt-test',
  agentId: 'agent-test',
  agentName: 'Agent Test',
  agentUsername: 'agent-test',
};

/** Create a fresh fixture for one case and return its path. */
function makeFixture(label: string, tag: string): string {
  const p = track(path.join(TMP, `${tag}-${label}`));
  switch (label) {
    case 'empty':
      return '';
    case 'whitespace':
      return '   ';
    case 'nonexistent':
      return p;
    case 'file': {
      fs.rmSync(p, { force: true });
      fs.writeFileSync(p, 'x');
      return p;
    }
    case 'dangling-symlink': {
      fs.rmSync(p, { force: true });
      fs.symlinkSync(path.join(TMP, `${tag}-ghost-${label}`), p);
      return p;
    }
    default:
      throw new Error(`unknown fixture ${label}`);
  }
}

const INVALID_LABELS = ['empty', 'whitespace', 'nonexistent', 'file', 'dangling-symlink'];

describe('bridge entrypoint --cwd preflight (SCLI-493)', () => {
  for (const label of INVALID_LABELS) {
    it(`codex-bridge entrypoint rejects ${label} --cwd with the concise diagnostic`, async () => {
      const cwd = makeFixture(label, 'cx');
      await expect(startCodexBridge({ ...BASE_OPTS, cwd })).rejects.toThrow(/--cwd/);
    });
  }

  for (const label of INVALID_LABELS) {
    it(`openclaw-bridge entrypoint rejects ${label} --cwd with the concise diagnostic`, async () => {
      const cwd = makeFixture(label, 'oc');
      await expect(startOpenClawBridge({ ...BASE_OPTS, cwd })).rejects.toThrow(/--cwd/);
    });
  }

  it('rejection message is a single concise line naming --cwd (no raw fs stack frame)', async () => {
    const file = track(path.join(TMP, 'cx-nostack'));
    fs.writeFileSync(file, 'x');
    let msg = '';
    try {
      await startCodexBridge({ ...BASE_OPTS, cwd: file });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('--cwd');
    // A raw fs/SQLite stack would contain "node:fs" / "StateStore" / "at ".
    expect(msg).not.toMatch(/node:fs|StateStore|\n\s+at /);
  });
});
