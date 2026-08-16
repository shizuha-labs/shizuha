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

describe('heartbeat cross-inbox priority contract', () => {
  it('keeps every runtime prompt on priority-first arbitration with alert tie-breaks', () => {
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
      expect(surface).toContain('highest-priority');
      expect(surface).toContain('alerts win ties');
      expect(surface).toContain('never preempt higher-priority task WIP');
      expect(surface).not.toContain('Alerts outrank tasks');
      expect(surface).not.toContain('active alert before ordinary');
    }
  });
});
