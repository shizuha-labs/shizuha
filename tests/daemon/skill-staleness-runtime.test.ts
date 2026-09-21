import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillStalenessNoticeForTurn } from '../../src/daemon/skill-staleness-runtime.js';

const originalSkillsDir = process.env['SHIZUHA_SKILLS_DIR'];
const originalLockUrl = process.env['SHIZUHA_RUNTIME_SKILLS_LOCK_URL'];
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-staleness-runtime-'));
});

afterEach(() => {
  if (originalSkillsDir === undefined) delete process.env['SHIZUHA_SKILLS_DIR'];
  else process.env['SHIZUHA_SKILLS_DIR'] = originalSkillsDir;
  if (originalLockUrl === undefined) delete process.env['SHIZUHA_RUNTIME_SKILLS_LOCK_URL'];
  else process.env['SHIZUHA_RUNTIME_SKILLS_LOCK_URL'] = originalLockUrl;
  // Reset the module-level lock cache between tests.
  delete process.env['SHIZUHA_SKILLS_DIR'];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.env['SHIZUHA_SKILLS_DIR'] = originalSkillsDir ?? '';
  if (originalSkillsDir === undefined) delete process.env['SHIZUHA_SKILLS_DIR'];
});

/** Build a git checkout with a linear history of N commits, each touching `name`.
 * Returns the checkout dir. HEAD is at the newest commit; hashes are real. */
function makeSkillsCheckout(name: string, commits: { file: string; markdown: string }[]): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'master']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@shizuha.io']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  for (const c of commits) {
    const p = path.join(dir, c.file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.markdown, 'utf-8');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', `commit ${c.file}`]);
  }
  return dir;
}

function rev(dir: string, ref: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', ref], { encoding: 'utf-8' }).trim();
}

const CONVERGED_POD = 'f98ddca92d071b62a3a7f1a79319a107bc8954ce';

describe('buildSkillStalenessNoticeForTurn (runtime reader)', () => {
  it('renders nothing when the pod revision and lock and checkout HEAD converge', async () => {
    const dir = makeSkillsCheckout('converged', [{ file: 'ping/SKILL.md', markdown: '---\nname: ping\ncritical: false\n---\n# ping\nbody' }]);
    const head = rev(dir, 'HEAD');
    process.env['SHIZUHA_SKILLS_DIR'] = dir;

    const notice = await buildSkillStalenessNoticeForTurn({
      skillsDir: dir,
      podRevision: head,           // pod already at published HEAD
      lockRevision: head,          // lock == published == pod
    });
    expect(notice).toBeNull();
  });

  it('renders a behind notice with count+critical when pod is behind published head', async () => {
    const dir = makeSkillsCheckout('behind', [
      { file: 'ping/SKILL.md', markdown: '---\nname: ping\ncritical: false\n---\n# ping\nv1' },
      { file: 'ping/SKILL.md', markdown: '---\nname: ping\ncritical: true\n---\n# ping\nv2 critical' },
      { file: 'other/SKILL.md', markdown: '---\nname: other\ncritical: false\n---\n# other\nv3' },
    ]);
    const podRev = rev(dir, 'HEAD~2');  // two publications behind HEAD
    const head = rev(dir, 'HEAD');
    process.env['SHIZUHA_SKILLS_DIR'] = dir;

    const notice = await buildSkillStalenessNoticeForTurn({
      skillsDir: dir,
      podRevision: podRev,
      lockRevision: head,
    });
    expect(notice).not.toBeNull();
    expect(notice!).toContain('`2` publications behind');
    expect(notice!).toContain('touched a skill marked `critical: true`');
  });

  it('fails open (no notice) when the skills checkout lacks .git', async () => {
    const dir = path.join(tmpRoot, 'no-git');
    fs.mkdirSync(path.join(dir, 'ping'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ping', 'SKILL.md'), '---\nname: ping\n---\n# ping\n', 'utf-8');
    process.env['SHIZUHA_SKILLS_DIR'] = dir;

    // No lock source either -> unknown everywhere -> notice may render the
    // "could not determine" path, but must never throw and never report
    // "current" for unreachable data.
    const notice = await buildSkillStalenessNoticeForTurn({ skillsDir: dir });
    if (notice !== null) {
      expect(notice).toContain('Could not determine');
    }
  });
});

describe('production-order caller sequence (PLAT-5046)', () => {
  // Mirrors the real manager.ts sequence: startAgentProcess() calls
  // buildSkillStalenessNoticeForTurn() once per context assembly, appending
  // when non-null. The unit of regression is the SEQUENCE across >=2 top-level
  // attempts, not a single helper call.
  it('renders exactly once per behind turn and nothing once converged (2 attempts)', async () => {
    // Attempt 1: pod behind lock; lock behind published head.
    const dir = makeSkillsCheckout('seq', [
      { file: 'ping/SKILL.md', markdown: '---\nname: ping\ncritical: true\n---\n# ping\nv1' },
      { file: 'ping/SKILL.md', markdown: '---\nname: ping\ncritical: true\n---\n# ping\nv2' },
    ]);
    const podRev = rev(dir, 'HEAD~1');
    const head = rev(dir, 'HEAD');
    process.env['SHIZUHA_SKILLS_DIR'] = dir;

    const assemble = async (opts: Parameters<typeof buildSkillStalenessNoticeForTurn>[0]) => {
      const notice = await buildSkillStalenessNoticeForTurn(opts);
      return notice ? `# prompt\n\n${notice}` : '# prompt';
    };

    // Top-level attempt 1: behind -> notice appended exactly once.
    const attempt1 = await assemble({ skillsDir: dir, podRevision: podRev, lockRevision: head });
    const occurrences1 = attempt1.split('## ⚠️ Your skills may be out of date').length - 1;
    expect(occurrences1).toBe(1);
    expect(attempt1).toContain('`1` publications behind');

    // Top-level attempt 2, same state (no reset/advance): still behind exactly
    // once, no duplicate accumulation across attempts.
    const attempt2 = await assemble({ skillsDir: dir, podRevision: podRev, lockRevision: head });
    const occurrences2 = attempt2.split('## ⚠️ Your skills may be out of date').length - 1;
    expect(occurrences2).toBe(1);

    // Top-level attempt 3: pod has now caught up (converged) -> no notice.
    const attempt3 = await assemble({ skillsDir: dir, podRevision: head, lockRevision: head });
    expect(attempt3).toBe('# prompt');
    expect(attempt3).not.toContain('out of date');
  });
});
