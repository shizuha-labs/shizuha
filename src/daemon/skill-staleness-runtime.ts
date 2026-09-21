/**
 * Runtime reader for self-detectable skill staleness (PLAT-5046).
 *
 * The PURE comparison/render lives in src/shared/skill-staleness.ts; this
 * module is the daemon-side I/O half: it gathers the three revisions plus the
 * publication count and the critical-flag from the running pod and the skills
 * git checkout, feeds them to `evaluateSkillStaleness`, and returns the
 * rendered notice (or null on the converged path).
 *
 * Report-only by construction: the only thing this module does is READ files
 * and run `git rev-list`/`git rev-parse` (read-only queries). It cannot gate,
 * interrupt, defer, or change any roll constant. Every reader is fail-open:
 * an unreadable source yields `null`, never a guess, so `evaluateSkillStaleness`
 * reports `unknown` (never `current`) for things it could not determine.
 *
 * ## Sources
 *
 *   podRevision   /opt/skills/.source-revision
 *                 (written by Dockerfile.agent-runtime from the skills SHA the
 *                 image was built with). Local, synchronous, authoritative for
 *                 "what this pod carries".
 *
 *   published     HEAD of the skills git checkout (~/.shizuha/skills or the
 *                 SHIZUHA_SKILLS_DIR override). The daemon's skill-sync loop
 *                 keeps that checkout at origin/<branch> (fast-forward only),
 *                 so HEAD is the newest published skills revision without a
 *                 per-call network round-trip.
 *
 *   lockRevision  runtime-skills.lock in shizuha-beta — "what the current
 *                 runtime image pins". The pod image was built FROM a lock, so
 *                 the current lock is the revision a freshly built image would
 *                 carry. Fetched best-effort from the Origin raw URL with a
 *                 short timeout + TTL cache; on failure -> null (unknown roll
 *                 gap, build gap only).
 *
 *   count/critical  `git rev-list --count <pod>..<published>` and
 *                 `git diff --name-only <pod>..<published>` + frontmatter scan
 *                 on the changed SKILL.md files (latest working-tree state).
 *                 Both are pure read-only git queries against the local
 *                 checkout; unreachable/absent -> null (never invented).
 *
 * The published/count/critical queries are cheap local git reads, matching how
 * the existing skill-sync loop already drives the same checkout.
 */

import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { parseSkillFrontmatter } from '../skills/frontmatter.js';
import {
  evaluateSkillStaleness,
  renderSkillStalenessNotice,
  type SkillStalenessReport,
} from '../shared/skill-staleness.js';

const execFileAsync = promisify(execFile);

/** Where the running pod's skills revision is recorded. */
function podRevisionPath(home: string): string {
  // Mirror resolveSkillPath()'s candidates so dev/test overrides work the
  // same way every other skill reader sees them.
  const override = process.env['SHIZUHA_SKILLS_DIR'];
  const candidates = [
    override && path.join(override, '.source-revision'),
    path.join(home, '.shizuha', 'skills', '.source-revision'),
    '/opt/skills/.source-revision',
  ].filter((v): v is string => !!v);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0] ?? path.join(home, '.shizuha', 'skills', '.source-revision');
}

/** `runtime-skills.lock` raw URL on Origin — what the current image pins. */
const RUNTIME_SKILLS_LOCK_URL =
  process.env['SHIZUHA_RUNTIME_SKILLS_LOCK_URL']
  ?? 'https://origin.shizuha.com/shizuha-labs/shizuha/raw/branch/master/runtime-skills.lock';

const LOCK_CACHE_TTL_MS = 60_000;
let lockCache: { value: string | null; at: number } | null = null;

/** Fetch the current `runtime-skills.lock` value, best-effort, with TTL cache.
 * Any failure (network, HTTP, non-40-hex) yields null — never a guess. */
export async function fetchLockRevision(): Promise<string | null> {
  const now = Date.now();
  if (lockCache && now - lockCache.at < LOCK_CACHE_TTL_MS) return lockCache.value;
  try {
    const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '8', RUNTIME_SKILLS_LOCK_URL], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const value = stdout.trim().toLowerCase();
    const ok = /^[0-9a-f]{40}$/.test(value);
    lockCache = { value: ok ? value : null, at: now };
    return ok ? value : null;
  } catch {
    lockCache = { value: null, at: now };
    return null;
  }
}

/** Head of the local skills git checkout (kept current by skill-sync). */
async function publishedRevision(skillsDir: string): Promise<string | null> {
  if (!fs.existsSync(path.join(skillsDir, '.git'))) return null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', skillsDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const value = stdout.trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** `git rev-list --count <from>..HEAD` — publications between pod and published. */
async function publicationCount(skillsDir: string, from: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-C', skillsDir, 'rev-list', '--count', `${from}..HEAD`],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** True iff any SKILL.md changed in `from..HEAD` is `critical: true` (current
 * working-tree frontmatter). Read-only scan of the local checkout. */
async function criticalAmongPublications(skillsDir: string, from: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-C', skillsDir, 'diff', '--name-only', `${from}..HEAD`],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const files = stdout.split('\n').map((f) => f.trim()).filter(Boolean);
    const skillMds = files.filter((f) => f.endsWith('/SKILL.md'));
    for (const rel of skillMds) {
      const p = path.join(skillsDir, rel);
      if (!fs.existsSync(p)) continue;
      let raw = '';
      try {
        raw = fs.readFileSync(p, 'utf-8');
      } catch {
        continue;
      }
      if (parseSkillFrontmatter(raw).critical) return true;
    }
    // A changed directory may add a brand-new SKILL.md; also cover the case
    // where the diff names the skill dir but the file itself was the addition.
    return false;
  } catch {
    return null;
  }
}

/** Skills checkout dir: same candidates as resolveSkillPath(). */
export function resolveSkillsRuntimeDir(): string {
  const home = process.env['HOME'] ?? os.homedir();
  const override = process.env['SHIZUHA_SKILLS_DIR'];
  const candidates = [override, path.join(home, '.shizuha', 'skills'), '/opt/skills'].filter(
    (v): v is string => !!v,
  );
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0] ?? path.join(home, '.shizuha', 'skills');
}

export interface SkillStalenessRuntimeInput {
  /** Override for tests; defaults to resolveSkillsRuntimeDir(). */
  skillsDir?: string;
  /** Override the pod-revision reader for tests. */
  podRevision?: string | null;
  /** Override the lock-revision reader for tests. */
  lockRevision?: string | null;
}

/** Gather + evaluate + render, fail-open. Returns null on the converged path
 * (an up-to-date agent sees nothing) and never throws. */
export async function buildSkillStalenessNoticeForTurn(
  input: SkillStalenessRuntimeInput = {},
): Promise<string | null> {
  try {
    const home = process.env['HOME'] ?? os.homedir();
    const skillsDir = input.skillsDir ?? resolveSkillsRuntimeDir();
    const podRevision = input.podRevision !== undefined
      ? input.podRevision
      : readFileTrimmed(podRevisionPath(home));
    const lockRevision = input.lockRevision !== undefined ? input.lockRevision : await fetchLockRevision();
    const published = await publishedRevision(skillsDir);
    const count = podRevision && published ? await publicationCount(skillsDir, podRevision) : null;
    const critical = podRevision && published ? await criticalAmongPublications(skillsDir, podRevision) : null;

    const report: SkillStalenessReport = evaluateSkillStaleness({
      podRevision,
      lockRevision,
      publishedRevision: published,
      publicationsBehind: count,
      criticalAmongPublications: critical,
    });
    return renderSkillStalenessNotice(report);
  } catch {
    // Report-only: a failure to build the notice must never break agent start.
    return null;
  }
}

function readFileTrimmed(p: string): string | null {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const value = raw.trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
