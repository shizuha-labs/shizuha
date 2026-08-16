/**
 * Shared SKILL.md frontmatter parser.
 *
 * Every consumer of SKILL.md metadata (bridge-identity, loadStarredSkills,
 * installStarredSkillsForClaudeCode, GET /v1/skills, the loader's disk scan)
 * should go through this module. Keeps the regex + shape of the parsed result
 * in exactly one place so descriptions/starred/tags semantics don't drift.
 *
 * Not a full YAML parser — handles only the subset we use in SKILL.md:
 *   - string scalars (quoted or unquoted)
 *   - `starred: true`
 *   - `tags:` block arrays (`  - foo`) and inline arrays (`[foo, bar]`)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SkillFrontmatter {
  /** `name:` field, or null if missing. */
  name: string | null;
  /** `description:` field, or null if missing. */
  description: string | null;
  /** `starred: true` → file-level "always eager" default. */
  starred: boolean;
  /**
   * `critical: true` → the skill's full body MUST be inlined into the agent's
   * system prompt at spawn time, even on bridges (like Claude Code) that have
   * a native skill auto-discovery system. Use for skills that govern
   * correctness-critical behavior the agent MUST NOT skip reading before
   * acting — e.g. workflow state machines, heartbeat handling, org-context
   * discipline. Costs ~10-20K tokens per skill, so use sparingly.
   *
   * Non-critical starred skills are mounted to the bridge's native skills
   * directory (Claude Code auto-discovers by name+description; body loads
   * via use_skill). Critical skills ALSO get mounted, but additionally have
   * their body inlined so the agent can't miss them.
   */
  critical: boolean;
  /**
   * `agents_md: true` → skill *directive*: body is composed into workspace
   * AGENTS.md / CLAUDE.md at agent setup (prompt-cached, not compacted). Use
   * for capability must-obey packs that skill-loading alone can miss. Prefer
   * slim bodies; pair with capability skill_refs / tags matching the cap slug.
   */
  agentsMd: boolean;
  /** `tags:` block/inline array, empty if missing. */
  tags: string[];
  /**
   * `roles:` block/inline array — audience targeting (PLAT-458 §3.2), empty if
   * missing. Empty ⇒ universal (every agent). Matched against role AND team.
   */
  roles: string[];
  /** Everything after the closing `---`. Empty string when no body. */
  body: string;
}

const EMPTY: SkillFrontmatter = {
  name: null, description: null, starred: false, critical: false,
  agentsMd: false, tags: [], roles: [], body: '',
};

/** Parse the frontmatter + body from a raw SKILL.md string. */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const trimmed = raw.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---\n')) {
    return { ...EMPTY, body: trimmed };
  }
  const endIdx = trimmed.indexOf('\n---', 4);
  if (endIdx === -1) {
    return { ...EMPTY, body: trimmed };
  }
  const fm = trimmed.slice(4, endIdx);
  const body = trimmed.slice(endIdx + 4).replace(/^\n/, '');

  const name = extractScalar(fm, 'name');
  const description = extractScalar(fm, 'description');
  const starred = /^\s*starred:\s*true\s*$/m.test(fm);
  const critical = /^\s*critical:\s*true\s*$/m.test(fm);
  const agentsMd = /^\s*agents_md:\s*true\s*$/m.test(fm);
  const tags = extractStringArray(fm, 'tags');
  const roles = extractStringArray(fm, 'roles');

  return { name, description, starred, critical, agentsMd, tags, roles, body };
}

/** Read and parse a SKILL.md file. Returns null when the path is missing / unreadable. */
export function readSkillFrontmatter(filePath: string): SkillFrontmatter | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parseSkillFrontmatter(raw);
  } catch {
    return null;
  }
}

/** Resolve a skill name to its SKILL.md path. Returns null when it doesn't exist.
 *
 * Runtime agents mount the canonical catalog at `/opt/skills`; older coordinator
 * installs used `~/.shizuha/skills`. Check both so prompt construction can
 * inline critical skills regardless of which mount layout the bridge container
 * is running with.
 */
export function resolveSkillPath(skillName: string): string | null {
  const home = process.env['HOME'] ?? os.homedir();
  const configured = process.env['SHIZUHA_SKILLS_DIR'];
  const immutable = process.env['SHIZUHA_IMMUTABLE_SKILLS'] === '1';
  const candidates = (immutable
    ? [configured]
    : [configured, path.join(home, '.shizuha', 'skills'), '/opt/skills']
  ).filter((v): v is string => !!v);

  for (const dir of candidates) {
    const p = path.join(dir, skillName, 'SKILL.md');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Convenience: resolve + read in one call. */
export function readSkillByName(skillName: string): SkillFrontmatter | null {
  const p = resolveSkillPath(skillName);
  return p ? readSkillFrontmatter(p) : null;
}

/** List skill directory names available to frontmatter-based prompt builders. */
export function listSkillNames(): string[] {
  const home = process.env['HOME'] ?? os.homedir();
  const configured = process.env['SHIZUHA_SKILLS_DIR'];
  const immutable = process.env['SHIZUHA_IMMUTABLE_SKILLS'] === '1';
  const dirs = (immutable
    ? [configured]
    : [configured, path.join(home, '.shizuha', 'skills'), '/opt/skills']
  ).filter((v): v is string => !!v);

  const names = new Set<string>();
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      if (fs.existsSync(skillPath)) names.add(entry.name);
    }
  }
  return [...names].sort();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractScalar(fm: string, key: string): string | null {
  // Line of the form:  key: value    (value may be quoted)
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm');
  const m = fm.match(re);
  if (!m) return null;
  const v = unquote(m[1]!);
  return v ? v : null;
}

function extractStringArray(fm: string, key: string): string[] {
  // Inline form:  tags: [a, b, c]
  const inlineRe = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm');
  const inline = fm.match(inlineRe);
  if (inline) {
    return inline[1]!.split(',').map((s) => unquote(s)).filter(Boolean);
  }
  // Block form:
  //   tags:
  //     - foo
  //     - bar
  const blockRe = new RegExp(`^${key}:\\s*\\n((?:[ \\t]+-\\s+.+\\n?)+)`, 'm');
  const block = fm.match(blockRe);
  if (block) {
    const out: string[] = [];
    for (const line of block[1]!.split('\n')) {
      const item = line.match(/^[ \t]+-\s+(.+?)\s*$/);
      if (item) out.push(unquote(item[1]!));
    }
    return out;
  }
  return [];
}
