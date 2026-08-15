import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_BASE_INSTRUCTIONS } from '../../src/agent-base-instructions.js';
import { listSkillNames, readSkillByName, resolveSkillPath } from '../../src/skills/frontmatter.js';

const ORIGINAL_SKILLS_DIR = process.env['SHIZUHA_SKILLS_DIR'];
const ORIGINAL_IMMUTABLE_SKILLS = process.env['SHIZUHA_IMMUTABLE_SKILLS'];

afterEach(() => {
  if (ORIGINAL_SKILLS_DIR === undefined) delete process.env['SHIZUHA_SKILLS_DIR'];
  else process.env['SHIZUHA_SKILLS_DIR'] = ORIGINAL_SKILLS_DIR;
  if (ORIGINAL_IMMUTABLE_SKILLS === undefined) delete process.env['SHIZUHA_IMMUTABLE_SKILLS'];
  else process.env['SHIZUHA_IMMUTABLE_SKILLS'] = ORIGINAL_IMMUTABLE_SKILLS;
});

describe('skill frontmatter path resolution', () => {
  it('reads skills from the runtime catalog mount when configured', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-skills-dir-'));
    try {
      const skillDir = path.join(tmp, 'pulse-core');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: pulse-core
description: Core Pulse workflow rules every agent needs.
starred: true
critical: true
---
# Pulse Core
Full workflow transition procedure.
`);

      process.env['SHIZUHA_SKILLS_DIR'] = tmp;

      expect(resolveSkillPath('pulse-core')).toBe(path.join(skillDir, 'SKILL.md'));
      const meta = readSkillByName('pulse-core');
      expect(meta?.critical).toBe(true);
      expect(meta?.body).toContain('Full workflow transition procedure');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses only the configured immutable catalog for controller prompt construction', () => {
    const configured = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-immutable-skills-'));
    const mutableHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-mutable-home-'));
    const originalHome = process.env['HOME'];
    try {
      fs.mkdirSync(path.join(configured, 'reviewed-skill'), { recursive: true });
      fs.writeFileSync(path.join(configured, 'reviewed-skill', 'SKILL.md'), '---\nname: reviewed-skill\ndescription: reviewed\n---\n');
      fs.mkdirSync(path.join(mutableHome, '.shizuha', 'skills', 'unreviewed-skill'), { recursive: true });
      fs.writeFileSync(path.join(mutableHome, '.shizuha', 'skills', 'unreviewed-skill', 'SKILL.md'), '---\nname: unreviewed-skill\ndescription: mutable\n---\n');

      process.env['HOME'] = mutableHome;
      process.env['SHIZUHA_SKILLS_DIR'] = configured;
      process.env['SHIZUHA_IMMUTABLE_SKILLS'] = '1';

      expect(resolveSkillPath('reviewed-skill')).toBe(path.join(configured, 'reviewed-skill', 'SKILL.md'));
      expect(resolveSkillPath('unreviewed-skill')).toBeNull();
      expect(listSkillNames()).toEqual(['reviewed-skill']);
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      fs.rmSync(configured, { recursive: true, force: true });
      fs.rmSync(mutableHome, { recursive: true, force: true });
    }
  });

  it('keeps the bundled heartbeat doctrine compatible with bounded Codex drains', () => {
    const bundled = fs.readFileSync(
      path.resolve('src/skills/integrations/heartbeat-protocol/SKILL.md'),
      'utf8',
    );
    expect(AGENT_BASE_INSTRUCTIONS).toContain("scheduler trigger's drain mode");
    expect(bundled).toContain('a **bounded** trigger ends after that task');
    expect(bundled).toContain('without either successor mechanism is still a throughput bug');
  });
});
