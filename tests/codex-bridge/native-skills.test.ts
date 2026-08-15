import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { selectCodexNativeSkillNames } from '../../src/codex-bridge/index.js';


const tempDirs: string[] = [];

function catalog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-skills-'));
  tempDirs.push(dir);
  return dir;
}

function skill(dir: string, name: string, frontmatter = ''): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} guidance\n${frontmatter}---\nBody\n`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex native skill catalog selection', () => {
  it('installs configured, universal, starred, and critical skills only', () => {
    const dir = catalog();
    skill(dir, 'engineering-core');
    skill(dir, 'heartbeat-protocol');
    skill(dir, 'starred-guide', 'starred: true\n');
    skill(dir, 'critical-guide', 'critical: true\n');
    skill(dir, 'ordinary-unrelated');

    expect(selectCodexNativeSkillNames(
      dir,
      'engineering-core',
      'Engineer',
      'engineering',
    )).toEqual([
      'critical-guide',
      'engineering-core',
      'heartbeat-protocol',
      'starred-guide',
    ]);
  });

  it('honors role audience filters even for explicitly configured skills', () => {
    const dir = catalog();
    skill(dir, 'finance-only', 'roles: [finance]\n');
    skill(dir, 'engineering-only', 'roles: [engineering]\n');

    expect(selectCodexNativeSkillNames(
      dir,
      'finance-only,engineering-only',
      'Engineer',
      'engineering',
    )).toEqual(['engineering-only']);
  });

  it('returns an empty selection for a missing catalog', () => {
    expect(selectCodexNativeSkillNames('/does/not/exist', 'engineering-core')).toEqual([]);
  });
});
