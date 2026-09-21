import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGENT_UNIVERSAL_CORE,
  HEARTBEAT_TRIGGER,
  LEAN_CONVERSATIONAL_AGENTS_MD,
} from '../../src/agent-base-instructions.js';
import { formatIdleHeartbeatNudge } from '../../src/gateway/agent-process.js';

const FORBIDDEN = [
  /Standing by/i,
  /end silent/i,
  /~hourly/,
  /~30m/,
  /if you need the (current )?inbox/i,
  /lecture you to call a tool/i,
  /If you have ready Pulse work, call/,
];

function read(rel: string): string {
  return fs.readFileSync(path.resolve(rel), 'utf8');
}

describe('heartbeat prompt has one contract and no wrap-up bait', () => {
  const skill = read('src/skills/integrations/heartbeat-protocol/SKILL.md');
  const heartbeatMd = read('src/daemon/templates/HEARTBEAT.md');
  const cron = read('src/tools/builtin/cron.ts');
  const nudge = formatIdleHeartbeatNudge({ ready: true });

  const surfaces: Array<[string, string]> = [
    ['HEARTBEAT_TRIGGER', HEARTBEAT_TRIGGER],
    ['formatIdleHeartbeatNudge', nudge],
    ['AGENT_UNIVERSAL_CORE', AGENT_UNIVERSAL_CORE],
    ['LEAN_CONVERSATIONAL_AGENTS_MD', LEAN_CONVERSATIONAL_AGENTS_MD],
    ['heartbeat-protocol skill', skill],
    ['HEARTBEAT.md template', heartbeatMd],
  ];

  it('user-message surfaces are the same HEARTBEAT_TRIGGER string', () => {
    expect(nudge).toBe(HEARTBEAT_TRIGGER);
    expect(cron).toContain('HEARTBEAT_TRIGGER');
    expect(cron).not.toMatch(/If you have ready Pulse work, call/);
  });

  it('every surface tells the model to call get_my_work first, then stop with no text if empty', () => {
    for (const [name, text] of surfaces) {
      expect(text, name).toContain('pulse_get_my_work');
    }
    expect(HEARTBEAT_TRIGGER).toContain('Call `mcp__shizuha-pulse__pulse_get_my_work` once');
    expect(skill).toContain('Call `mcp__shizuha-pulse__pulse_get_my_work` **once**');
    expect(AGENT_UNIVERSAL_CORE).toContain('Call `mcp__shizuha-pulse__pulse_get_my_work` once');
  });

  it('forbids wrap-up bait and competing cadences / if-you-need / lecture-not', () => {
    for (const [name, text] of surfaces) {
      for (const re of FORBIDDEN) {
        expect(text, `${name} matched ${re}`).not.toMatch(re);
      }
    }
  });
});
