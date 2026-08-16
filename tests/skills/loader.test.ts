import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSkills } from '../../src/skills/loader.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import type { Skill } from '../../src/skills/types.js';

describe('Skill System', () => {
  const tmpDir = path.join(os.tmpdir(), `shizuha-skill-test-${Date.now()}`);
  const skillsDir = path.join(tmpDir, '.shizuha', 'skills');

  beforeAll(() => {
    // Create test skill directories
    fs.mkdirSync(path.join(skillsDir, 'commit'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'review-pr'), { recursive: true });

    // Write test skill files
    fs.writeFileSync(path.join(skillsDir, 'commit', 'SKILL.md'), `---
name: commit
description: Create a well-structured git commit message.
allowed-tools:
  - Bash
  - Read
argument-hint: "[message]"
---

# Commit Skill

Run git status, analyze changes, create a conventional commit.
`);

    fs.writeFileSync(path.join(skillsDir, 'review-pr', 'SKILL.md'), `---
name: review-pr
description: Review a pull request for code quality, bugs, and style issues.
model: sonnet
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
user-invocable: true
---

# PR Review Skill

1. Fetch the PR diff
2. Analyze for bugs, style issues, and improvements
3. Leave constructive comments
`);

    // Write a legacy command file (flat .md, no directory)
    fs.mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'commands', 'deploy.md'), `---
name: deploy
description: Deploy the current branch to staging or production.
---

# Deploy

Run the deployment pipeline for the specified environment.
`);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadSkills', () => {
    it('discovers skills from .shizuha/skills/ directory when trusted', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      expect(skills.length).toBeGreaterThanOrEqual(2);

      const names = skills.map((s) => s.name);
      expect(names).toContain('commit');
      expect(names).toContain('review-pr');
    });

    it('discovers legacy .claude/commands/ skills when trusted', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const names = skills.map((s) => s.name);
      expect(names).toContain('deploy');
    });

    it('parses frontmatter fields correctly', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const commit = skills.find((s) => s.name === 'commit')!;

      expect(commit).toBeDefined();
      expect(commit.description).toBe('Create a well-structured git commit message.');
      expect(commit.allowedTools).toEqual(['Bash', 'Read']);
      expect(commit.argumentHint).toBe('[message]');
      expect(commit.userInvocable).toBe(true);
      expect(commit.source).toBe('project');
    });

    it('parses model override', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const review = skills.find((s) => s.name === 'review-pr')!;

      expect(review).toBeDefined();
      expect(review.model).toBe('sonnet');
      expect(review.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    });

    it('skips skills without description', () => {
      // Create a skill with no description
      const noDescDir = path.join(skillsDir, 'no-desc');
      fs.mkdirSync(noDescDir, { recursive: true });
      fs.writeFileSync(path.join(noDescDir, 'SKILL.md'), `---
name: no-desc
---

Just a body, no description.
`);

      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const names = skills.map((s) => s.name);
      expect(names).not.toContain('no-desc');

      // Cleanup
      fs.rmSync(noDescDir, { recursive: true });
    });

    it('returns no project skills for non-existent directories', () => {
      const skills = loadSkills('/tmp/nonexistent-dir-12345');
      // Only user-level skills (~/.shizuha/skills/) may be found;
      // none should come from the non-existent project directory.
      const projectSkills = skills.filter((s) => s.source === 'project');
      expect(projectSkills).toEqual([]);
    });

    it('handles OpenClaw skill format with nested metadata', () => {
      const ocDir = path.join(skillsDir, 'github');
      fs.mkdirSync(ocDir, { recursive: true });
      fs.writeFileSync(path.join(ocDir, 'SKILL.md'), `---
name: github
description: "GitHub operations via gh CLI: issues, PRs, CI runs."
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: ["gh"]
---

# GitHub Skill

Use the \`gh\` CLI to interact with GitHub.
`);

      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const github = skills.find((s) => s.name === 'github');
      expect(github).toBeDefined();
      expect(github!.description).toBe('GitHub operations via gh CLI: issues, PRs, CI runs.');
      // metadata.openclaw is ignored gracefully (no crash)

      fs.rmSync(ocDir, { recursive: true });
    });

    it('handles Hermes skill format', () => {
      const hermesDir = path.join(skillsDir, 'hermes-agent');
      fs.mkdirSync(hermesDir, { recursive: true });
      fs.writeFileSync(path.join(hermesDir, 'SKILL.md'), `---
name: hermes-agent-spawning
description: Spawn additional Hermes Agent instances for parallel work.
version: 1.1.0
author: Hermes Agent
---

# Spawning Hermes Agent Instances

Instructions for spawning sub-agents.
`);

      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const hermes = skills.find((s) => s.name === 'hermes-agent-spawning');
      expect(hermes).toBeDefined();
      expect(hermes!.version).toBe('1.1.0');

      fs.rmSync(hermesDir, { recursive: true });
    });
  });

  describe('project skill trust gate', () => {
    it('skips project skills by default (trustProjectSkills: false)', () => {
      const skills = loadSkills(tmpDir);
      const projectSkills = skills.filter((s) => s.source === 'project');
      expect(projectSkills).toHaveLength(0);
    });

    it('skips project skills when explicitly untrusted', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: false });
      const projectSkills = skills.filter((s) => s.source === 'project');
      expect(projectSkills).toHaveLength(0);
    });

    it('loads project skills when explicitly trusted', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const projectSkills = skills.filter((s) => s.source === 'project');
      expect(projectSkills.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('SkillRegistry', () => {
    it('registers and retrieves skills', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const registry = new SkillRegistry();
      registry.registerAll(skills);

      expect(registry.size).toBeGreaterThanOrEqual(2);
      expect(registry.has('commit')).toBe(true);
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('normalizes lookup names (strips /, lowercases)', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const registry = new SkillRegistry();
      registry.registerAll(skills);

      expect(registry.get('/commit')).toBeDefined();
      expect(registry.get('COMMIT')).toBeDefined();
    });

    it('lists user-invocable skills', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const registry = new SkillRegistry();
      registry.registerAll(skills);

      const invocable = registry.listUserInvocable();
      expect(invocable.length).toBeGreaterThanOrEqual(2);
    });

    it('invokes a skill and returns prompt content', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const registry = new SkillRegistry();
      registry.registerAll(skills);

      const result = registry.invoke('commit', 'fix auth bug');
      expect(result.success).toBe(true);
      expect(result.skillName).toBe('commit');
      expect(result.mode).toBe('inline');
      expect(result.prompt).toContain('Commit Skill');
      expect(result.prompt).toContain('User arguments: fix auth bug');
      expect(result.allowedTools).toEqual(['Bash', 'Read']);
    });

    it('returns failure for unknown skills', () => {
      const registry = new SkillRegistry();
      const result = registry.invoke('nonexistent');
      expect(result.success).toBe(false);
    });

    it('builds a catalog for system prompt', () => {
      const skills = loadSkills(tmpDir, { trustProjectSkills: true });
      const registry = new SkillRegistry();
      registry.registerAll(skills);

      const catalog = registry.buildCatalog();
      expect(catalog).toContain('## Available Skills');
      expect(catalog).toContain('commit');
      expect(catalog).toContain('review-pr');
      expect(catalog).toContain('skill');
    });
  });

  // PLAT-465 (BUILD-1) — role/team-targeted catalog filter (HLD PLAT-458 §3.3).
  // Guards the non-breaking default + OR-semantics of buildCatalog/skillMatchesAudience;
  // this is the fleet-wide skill loader and shizuha-beta has no working CI, so this
  // unit test is the safety net (per aoi's merge-gate requirement).
  describe('buildCatalog role/team targeting (PLAT-465)', () => {
    const mkSkill = (name: string, roles?: string[], starred?: boolean): Skill => ({
      name,
      description: `desc for ${name}`,
      contentPath: '',
      skillRoot: '',
      source: 'user',
      userInvocable: true,
      disableModelInvocation: false,
      ...(roles ? { roles } : {}),
      ...(starred ? { starred } : {}),
    });

    const registryWith = (...skills: Skill[]): SkillRegistry => {
      const r = new SkillRegistry();
      r.registerAll(skills);
      return r;
    };

    it('back-compat: no-arg buildCatalog() returns the full catalog (every model-invocable skill)', () => {
      const r = registryWith(mkSkill('universal'), mkSkill('eng-only', ['engineer']), mkSkill('arch-only', ['architect']));
      const catalog = r.buildCatalog();
      expect(catalog).toContain('universal');
      expect(catalog).toContain('eng-only');
      expect(catalog).toContain('arch-only');
    });

    it('PLAT-4189: catalog is emitted in a stable name-sorted order regardless of registration order (KV-cache determinism)', () => {
      // Registration order must NOT leak into the prompt — otherwise a restart
      // that loads skills in a different filesystem order reorders this section
      // and invalidates the whole vLLM prefix cache.
      const forward = registryWith(mkSkill('alpha'), mkSkill('bravo'), mkSkill('charlie'));
      const reverse = registryWith(mkSkill('charlie'), mkSkill('bravo'), mkSkill('alpha'));
      expect(forward.buildCatalog()).toBe(reverse.buildCatalog());
      const lines = forward.buildCatalog().split('\n').filter((l) => l.startsWith('- **'));
      expect(lines).toEqual([...lines].sort());
    });

    it('universal: a skill with no roles: is included for any (role, team) and for no-context', () => {
      const r = registryWith(mkSkill('universal'));
      expect(r.buildCatalog('engineer', 'engineering')).toContain('universal');
      expect(r.buildCatalog('architect', 'platform')).toContain('universal');
      expect(r.buildCatalog()).toContain('universal');
    });

    it('role-targeted: roles:[engineer] is included for role=engineer, excluded for role=architect and no-context-with-others', () => {
      const r = registryWith(mkSkill('eng-only', ['engineer']), mkSkill('universal'));
      expect(r.buildCatalog('engineer')).toContain('eng-only');
      expect(r.buildCatalog('architect')).not.toContain('eng-only');
      // no-context returns the full catalog (back-compat), so eng-only IS present there —
      // exclusion only happens once a non-matching role/team context is supplied.
      expect(r.buildCatalog('architect')).toContain('universal');
    });

    it('OR-semantics (P3-B): a roles: entry is matched against BOTH role AND team — a team-named entry matches the team even when the role differs', () => {
      // HLD §3.3: "one list can scope a skill to a role (engineer) or a team (devops)."
      // An entry must EQUAL the role value OR the team value (exact, case-insensitive) —
      // 'engineer' (a role) does NOT match team='engineering', so the OR axis is exercised
      // with a team-named entry.
      const teamScoped = registryWith(mkSkill('devops-skill', ['devops']));
      expect(teamScoped.buildCatalog('engineer', 'devops')).toContain('devops-skill'); // matches via TEAM
      expect(teamScoped.buildCatalog('engineer', 'platform')).not.toContain('devops-skill');

      const roleScoped = registryWith(mkSkill('eng-only', ['engineer']));
      expect(roleScoped.buildCatalog('engineer', 'platform')).toContain('eng-only');    // matches via ROLE
      expect(roleScoped.buildCatalog('ENGINEER')).toContain('eng-only');                // case-insensitive
    });

    it('starred is load-eagerness, not audience: the role filter still applies to starred skills', () => {
      const r = registryWith(mkSkill('starred-eng', ['engineer'], true), mkSkill('starred-univ', undefined, true));
      // a starred role-scoped skill does NOT bypass the audience filter:
      expect(r.buildCatalog('architect')).not.toContain('starred-eng');
      expect(r.buildCatalog('engineer')).toContain('starred-eng');
      // a starred universal skill is still included for everyone:
      expect(r.buildCatalog('architect')).toContain('starred-univ');
    });

    it('multi-entry roles: matches on any listed role/team', () => {
      const r = registryWith(mkSkill('multi', ['qa_engineer', 'devops']));
      expect(r.buildCatalog('devops')).toContain('multi');          // matches 2nd entry as role
      expect(r.buildCatalog('someone', 'qa_engineer')).toContain('multi'); // matches 1st entry as team
      expect(r.buildCatalog('engineer', 'platform')).not.toContain('multi');
    });
  });
});
