import { describe, expect, it } from 'vitest';
import { formatToolActivityLabel } from '../../src/tui/hooks/useAgentSession.js';

describe('compact live tool activity label', () => {
  it('uses the first meaningful bash segment and stays on one short line', () => {
    const label = formatToolActivityLabel('bash', {
      command: 'cd /home/phoenix/work && echo heading && grep -rn "warmup|probe" vendor/hermes-agent',
    });

    expect(label).toContain('Running bash \u00b7 grep -rn');
    expect(label).not.toContain('/home/phoenix/work');
    expect(label.length).toBeLessThanOrEqual(55);
    expect(label).not.toContain('\n');
  });

  it('summarizes query tools without exposing result bodies', () => {
    const label = formatToolActivityLabel('session_search', {
      query: 'tmux mouse scroll shizuha1 copy mode scrollback',
    });

    expect(label).toMatch(/^Running session_search \u00b7 tmux mouse/);
    expect(label.length).toBeLessThanOrEqual(65);
  });

  it('shortens MCP names to the useful operation', () => {
    expect(formatToolActivityLabel(
      'mcp__shizuha-pulse__pulse_get_my_tasks',
      {},
    )).toBe('Running pulse_get_my_tasks...');
  });
});
