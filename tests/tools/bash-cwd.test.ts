import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bashTool } from '../../src/tools/builtin/bash.js';
import type { ToolContext } from '../../src/tools/types.js';

// Regression: `bash` is stateless per call, so `cd foo` in one call used to be
// lost before the next call — the model would run `docker compose up` from the
// repo root, fail with "no configuration file provided", and repeat until the
// loop-guard stopped it. The fix persists cwd per session (like a real shell).

function ctx(cwd: string, sessionId: string): ToolContext {
  return { cwd, sessionId } as unknown as ToolContext;
}
function run(command: string, c: ToolContext) {
  return bashTool.execute({ command }, c);
}

describe('bash cwd persistence across calls (per session)', () => {
  let base: string;
  let sub: string;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bashcwd-')));
    sub = path.join(base, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'marker.txt'), 'HELLO');
  });

  it('persists `cd` from one call to the next (the docker-compose case)', async () => {
    const c = ctx(base, 'sess-A');
    const cd = await run(`cd ${sub}`, c);
    expect(cd.isError).toBe(false);

    const pwd = await run('pwd', c);
    expect(pwd.content).toContain(sub);
    // ground-truth cwd annotation present when outside the base dir
    expect(pwd.content).toContain(`[cwd: ${sub}]`);

    // A relative command now resolves in the cd'd directory — this is exactly
    // the case that used to loop-fail (`cat marker.txt` / `docker compose up`).
    const cat = await run('cat marker.txt', c);
    expect(cat.isError).toBe(false);
    expect(cat.content).toContain('HELLO');
  });

  it('annotates the actual cwd when a command FAILS (the docker-compose case)', async () => {
    // Command run from the base dir that fails — the model must see WHERE it ran.
    const c = ctx(base, 'sess-fail-cwd');
    const r = await run('cat does-not-exist.txt', c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`[cwd: ${base}]`);
  });

  it('keeps cwd isolated per session', async () => {
    const a = ctx(base, 'sess-iso-A');
    const b = ctx(base, 'sess-iso-B');
    await run(`cd ${sub}`, a);
    const pwdB = await run('pwd', b);
    expect(pwdB.content.trim()).toBe(base); // session B is unaffected by A's cd
  });

  it('falls back to the agent cwd if the persisted dir is deleted', async () => {
    const c = ctx(base, 'sess-del');
    const gone = path.join(base, 'gone');
    fs.mkdirSync(gone);
    await run(`cd ${gone}`, c);
    fs.rmSync(gone, { recursive: true, force: true });
    const pwd = await run('pwd', c);
    expect(pwd.content.trim()).toBe(base);
  });

  it('never leaks the cwd-capture sentinel into command output', async () => {
    const c = ctx(base, 'sess-clean');
    const r = await run('echo hello-world', c);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('hello-world');
    expect(r.content).not.toContain('__shizuha');
  });

  it('preserves the command exit code (cwd capture does not mask failures)', async () => {
    const c = ctx(base, 'sess-rc');
    const r = await run('exit 3', c);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/exit code 3|Exit code: 3/i);
    // and a non-zero exit with output still surfaces the code
    const r2 = await run('echo boom; exit 7', c);
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain('Exit code: 7');
  });
});
