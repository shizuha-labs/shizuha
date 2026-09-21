import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  AGENT_BASE_INSTRUCTIONS,
  HEARTBEAT_TRIGGER,
} from '../../src/agent-base-instructions.js';
import {
  CODEX_HEARTBEAT_OBSERVATION_RETRY_TRIGGER,
  CODEX_HEARTBEAT_TRIGGER,
} from '../../src/codex-bridge/index.js';
import {
  CLAUDE_HEARTBEAT_OBSERVATION_RETRY_TRIGGER,
} from '../../src/claude-bridge/index.js';

describe('heartbeat combined-inbox contract', () => {
  it('keeps every runtime prompt on pulse_get_my_work with agent choice, not harness order', () => {
    const providerProfiles = fs.readFileSync(
      path.resolve('src/provider/model-profile.ts'),
      'utf8',
    );
    const gateway = fs.readFileSync(
      path.resolve('src/gateway/agent-process.ts'),
      'utf8',
    );
    const bundledSkill = fs.readFileSync(
      path.resolve('src/skills/integrations/heartbeat-protocol/SKILL.md'),
      'utf8',
    );

    for (const surface of [
      AGENT_BASE_INSTRUCTIONS,
      HEARTBEAT_TRIGGER,
      CODEX_HEARTBEAT_TRIGGER,
      CODEX_HEARTBEAT_OBSERVATION_RETRY_TRIGGER,
      CLAUDE_HEARTBEAT_OBSERVATION_RETRY_TRIGGER,
      providerProfiles,
      gateway,
      bundledSkill,
    ]) {
      expect(surface).toContain('pulse_get_my_work');
      expect(surface).not.toContain('alerts win ties');
      expect(surface).not.toContain('Alerts outrank tasks');
      expect(surface).not.toContain('ordered alert-then-task pair is MANDATORY');
    }
    expect(bundledSkill).toContain('critical: true');
    expect(bundledSkill).toContain('agents_md: true');
    expect(bundledSkill).toContain('You choose');
    expect(bundledSkill).toContain('Floor skill');
    expect(AGENT_BASE_INSTRUCTIONS).toContain('the harness does not pick an item');
    expect(HEARTBEAT_TRIGGER).toContain('Call `mcp__shizuha-pulse__pulse_get_my_work` once');
    expect(HEARTBEAT_TRIGGER).toContain('stop with no text');
    expect(HEARTBEAT_TRIGGER).toContain('will not fetch Pulse');
    expect(HEARTBEAT_TRIGGER).not.toMatch(/If you have ready Pulse work, call/);
  });
});
