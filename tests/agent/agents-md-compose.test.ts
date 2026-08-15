import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AGENT_UNIVERSAL_CORE,
  composeAgentsMd,
  writeBaseInstructions,
} from '../../src/agent-base-instructions.js';

describe('composeAgentsMd', () => {
  const prevSkills = process.env['SHIZUHA_SKILLS_DIR'];
  const prevCaps = process.env['AGENT_EFFECTIVE_CAPABILITIES'];
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
    process.env['SHIZUHA_SKILLS_DIR'] = tmp;
    // review capability should pull review-tagged directives
    process.env['AGENT_EFFECTIVE_CAPABILITIES'] = 'review';
    for (const [name, fm, body] of [
      [
        'pulse-review',
        'name: pulse-review\nagents_md: true\nstarred: true\ncritical: true\ntags:\n  - review\n',
        '# Review seat\nApprove only.\n',
      ],
      [
        'agents-md-shipping',
        'name: agents-md-shipping\nagents_md: true\ntags:\n  - engineering\n',
        '# Shipping\nPush PRs.\n',
      ],
    ] as const) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${fm}---\n\n${body}`);
    }
  });

  afterEach(() => {
    if (prevSkills === undefined) delete process.env['SHIZUHA_SKILLS_DIR'];
    else process.env['SHIZUHA_SKILLS_DIR'] = prevSkills;
    if (prevCaps === undefined) delete process.env['AGENT_EFFECTIVE_CAPABILITIES'];
    else process.env['AGENT_EFFECTIVE_CAPABILITIES'] = prevCaps;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('universal core has no shipping block', () => {
    expect(AGENT_UNIVERSAL_CORE).not.toContain('Shipping code');
    expect(AGENT_UNIVERSAL_CORE).toContain('[HEARTBEAT]');
  });

  it('review capability composes pulse-review but not shipping', () => {
    const text = composeAgentsMd({ capabilities: ['review'] });
    expect(text).toContain('Approve only');
    expect(text).toContain('agents_md directive: pulse-review');
    expect(text).not.toContain('Push PRs');
  });

  it('engineering capability composes shipping directive', () => {
    process.env['AGENT_EFFECTIVE_CAPABILITIES'] = 'engineering';
    const text = composeAgentsMd({ capabilities: ['engineering'] });
    expect(text).toContain('Push PRs');
    expect(text).not.toContain('Approve only');
  });

  it('writeBaseInstructions writes AGENTS.md', () => {
    const out = path.join(tmp, 'ws');
    const result = writeBaseInstructions(out, { capabilities: ['review'] });
    expect(result.directives).toContain('pulse-review');
    const body = fs.readFileSync(path.join(out, 'AGENTS.md'), 'utf8');
    expect(body).toContain('[HEARTBEAT]');
    expect(body).toContain('Approve only');
  });
});
