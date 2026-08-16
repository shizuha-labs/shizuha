import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBridgeIdentityPrompt } from '../../src/prompt/bridge-identity.js';
import { buildClaudeSpawnArgs, buildClaudeSpawnEnv } from '../../src/claude-bridge/index.js';
import { buildOpenClawAgentParams } from '../../src/openclaw-bridge/index.js';
import { loadStarredSkills } from '../../src/daemon/manager.js';


const originalSkillsDir = process.env['SHIZUHA_SKILLS_DIR'];

afterEach(() => {
  if (originalSkillsDir === undefined) delete process.env['SHIZUHA_SKILLS_DIR'];
  else process.env['SHIZUHA_SKILLS_DIR'] = originalSkillsDir;
});

function writeSkill(root: string, name: string, frontmatter: string, body = 'Body'): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n${frontmatter.trim()}\n---\n# ${name}\n${body}\n`);
}

describe('bridge identity prompt', () => {
  it('derives a stable identity block from agent metadata and appends custom instructions', () => {
    const prompt = buildBridgeIdentityPrompt({
      name: 'Sara',
      username: 'sara',
      role: 'Engineer',
      skills: ['coding', 'debugging'],
      personalityTraits: { tone: 'direct', style: 'pragmatic' },
    }, 'Write clean code.');

    expect(prompt).toContain('You are Sara, a Shizuha agent.');
    expect(prompt).toContain('Your username is sara.');
    expect(prompt).toContain('Your role is Engineer.');
    expect(prompt).toContain('Do not present yourself as Claude Code, Codex, OpenClaw');
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('- coding');
    expect(prompt).toContain('## Personality Traits');
    expect(prompt).toContain('- style: pragmatic');
    expect(prompt).toContain('## Agent Instructions');
    expect(prompt).toContain('Write clean code.');
  });

  it('still produces identity guidance when no custom prompt exists', () => {
    const prompt = buildBridgeIdentityPrompt({
      name: 'Claw',
      username: 'claw',
      role: 'engineer',
      skills: [],
      personalityTraits: {},
    });

    expect(prompt).toContain('You are Claw, a Shizuha agent.');
    expect(prompt).not.toContain('## Agent Instructions');
  });



  it('respects roles frontmatter when surfacing eager skills in the bridge prompt', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-skills-'));
    process.env['SHIZUHA_SKILLS_DIR'] = tmp;
    writeSkill(tmp, 'eng-eager-test-skill', `
description: Engineer-only eager test skill
starred: true
roles: [engineer]
`);
    writeSkill(tmp, 'arch-eager-test-skill', `
description: Architect-only eager test skill
starred: true
roles: [architect]
`);

    const engineerPrompt = buildBridgeIdentityPrompt({
      name: 'Ryo',
      username: 'ryo',
      role: 'Engineer',
      team: 'engineering',
      skills: [],
      personalityTraits: {},
    });
    expect(engineerPrompt).toContain('eng-eager-test-skill');
    expect(engineerPrompt).not.toContain('arch-eager-test-skill');

    const architectPrompt = buildBridgeIdentityPrompt({
      name: 'Aoi',
      username: 'aoi',
      role: 'Architect',
      team: 'architecture',
      skills: [],
      personalityTraits: {},
    });
    expect(architectPrompt).not.toContain('eng-eager-test-skill');
    expect(architectPrompt).toContain('arch-eager-test-skill');
  });



  it('keeps non-critical starred skill bodies out of bridge inline context', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-skills-'));
    process.env['SHIZUHA_SKILLS_DIR'] = tmp;
    writeSkill(tmp, 'critical-inline-test-skill', `
description: Critical inline test skill
starred: true
critical: true
`, 'CRITICAL_INLINE_BODY');
    writeSkill(tmp, 'noncritical-starred-test-skill', `
description: Non-critical starred test skill
starred: true
critical: false
`, 'NONCRITICAL_STARRED_BODY');

    const inline = loadStarredSkills({
      name: 'Saki',
      role: 'Engineer',
      team: 'engineering',
      skills: [],
    }, { criticalOnly: true });

    expect(inline).toContain('critical-inline-test-skill');
    expect(inline).toContain('CRITICAL_INLINE_BODY');
    expect(inline).not.toContain('noncritical-starred-test-skill');
    expect(inline).not.toContain('NONCRITICAL_STARRED_BODY');

    const prompt = buildBridgeIdentityPrompt({
      name: 'Saki',
      username: 'saki',
      role: 'Engineer',
      team: 'engineering',
      skills: [],
      personalityTraits: {},
    });
    expect(prompt).toContain('critical-inline-test-skill');
    expect(prompt).toContain('noncritical-starred-test-skill');
    expect(prompt).not.toContain('CRITICAL_INLINE_BODY');
    expect(prompt).not.toContain('NONCRITICAL_STARRED_BODY');
  });


  it('handles undefined skills and personalityTraits (local agents)', () => {
    // Local agents from agents.json may not have skills/personalityTraits fields
    const prompt = buildBridgeIdentityPrompt({
      name: 'LocalBot',
      username: 'localbot',
      role: 'agent',
      skills: undefined as any,
      personalityTraits: undefined as any,
    });

    expect(prompt).toContain('You are LocalBot, a Shizuha agent.');
    // Every agent — even local agents with no per-agent skills — gets the
    // platform-universal skills (connect-messaging, heartbeat-protocol,
    // pulse-workflows), so a "## Skills" section is always present.
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('connect-messaging');
    // personalityTraits undefined → no Personality Traits section.
    expect(prompt).not.toContain('## Personality Traits');
  });

  it('surfaces Hive effective capability diagnostics in bridge identity prompts', () => {
    const prompt = buildBridgeIdentityPrompt({
      name: 'Ren',
      username: 'ren',
      role: 'Reviewer',
      team: 'review',
      skills: ['code-review'],
      personalityTraits: {},
      effectiveCapabilities: {
        source: 'hive',
        catalogVersion: 4,
        capabilities: ['review', 'security'],
        sourceTeams: ['review', 'security'],
        skills: ['code-review', 'security-audit'],
        eagerSkills: [],
        mcpServers: ['pulse', 'wiki'],
        credentialGrantScopes: [],
        runtimeFlags: {},
        diagnostics: [{ severity: 'warning', code: 'shadow_diff', message: 'legacy differs' }],
        appliedAt: '2026-07-01T00:00:00.000Z',
      },
    });

    expect(prompt).toContain('## Runtime Capabilities');
    expect(prompt).toContain('Catalog version: 4');
    expect(prompt).toContain('Source teams: review, security');
    expect(prompt).toContain('Capabilities: review, security');
    expect(prompt).toContain('Enabled platform MCP services: pulse, wiki');
    expect(prompt).toContain('Diagnostics: warning:shadow_diff');
  });

});

describe('OpenClaw agent params', () => {
  it('forwards the bridge identity prompt via extraSystemPrompt', () => {
    const params = buildOpenClawAgentParams({
      message: 'hello',
      threadId: 'thread-123',
      thinkingLevel: 'high',
      contextPrompt: 'You are Claw.',
    });

    expect(params).toMatchObject({
      message: 'hello',
      idempotencyKey: 'thread-123',
      sessionKey: 'agent:main:main',
      timeout: 600_000,
      thinking: 'high',
      extraSystemPrompt: 'You are Claw.',
    });
  });

  it('omits extraSystemPrompt when no bridge prompt was provided', () => {
    const params = buildOpenClawAgentParams({
      message: 'hello',
      threadId: 'thread-123',
    });

    expect(params['extraSystemPrompt']).toBeUndefined();
  });
});

describe('Claude bridge spawn args', () => {
  it('resumes when a stored session id exists', () => {
    const args = buildClaudeSpawnArgs({
      model: 'claude-sonnet-4-6',
      storedSessionId: '123e4567-e89b-12d3-a456-426614174000',
      contextPrompt: 'You are Sara.',
    });

    expect(args).toContain('--resume');
    expect(args).toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(args).toContain('--append-system-prompt');
  });

  it('starts fresh when no stored session id exists', () => {
    const args = buildClaudeSpawnArgs({
      model: 'claude-sonnet-4-6',
      contextPrompt: 'You are Sara.',
    });

    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
    expect(args).toContain('--append-system-prompt');
  });

  it('scrubs Claude Remote Control env while preserving inference OAuth', () => {
    const env = buildClaudeSpawnEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_REMOTE: '1',
      CLAUDE_CODE_REMOTE_FOO: 'bar',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9',
      CLAUDE_CODE_OAUTH_TOKEN: 'old-token',
    }, {
      homeDir: '/home/agent',
      user: 'agent',
      oauthToken: 'resolved-token',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/agent');
    expect(env.USER).toBe('agent');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('resolved-token');
    expect(env.CLAUDE_CODE_REMOTE).toBeUndefined();
    expect(env.CLAUDE_CODE_REMOTE_FOO).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
  });
});
