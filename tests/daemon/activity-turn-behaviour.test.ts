/**
 * The activity feed must show what a turn DID, not just what it cost.
 *
 * Operator 2026-08-05, on the Hive Live-activity feed while diagnosing a
 * needs_help agent:
 *
 *   i don't see the actual output tokens here in activity logs and i need to
 *   see those because without them we can't infer what the agent is thinking
 *   and doing .. we need to know its thinking process and its actions . rather
 *   than just looking at this summary which is useless
 *
 * "LLM turn completed: DeepSeek-V4-Flash, 3.2s, 59008 input tokens, 49 output
 * tokens, 0 tool calls" carries zero information about behaviour. The llm-turn
 * span now records a bounded excerpt of the assistant's text plus the tool
 * names it called, and the feed renders them.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const gatewaySrc = fs.readFileSync(
  path.resolve(import.meta.dirname!, '../../src/gateway/agent-process.ts'), 'utf-8',
);
const dashboardSrc = fs.readFileSync(
  path.resolve(import.meta.dirname!, '../../src/daemon/dashboard.ts'), 'utf-8',
);

describe('llm-turn telemetry carries behaviour', () => {
  it('records the assistant excerpt and tool names on the span', () => {
    const spanEnd = gatewaySrc.slice(
      gatewaySrc.indexOf('// GAP F: End turn span'),
      gatewaySrc.indexOf('expensiveTurnDecision = this.expensiveTurnGuard.record'),
    );
    expect(spanEnd).toContain('assistantExcerpt');
    expect(spanEnd).toContain('toolNames');
    // Bounded: .telemetry.jsonl is a tail-able log, not a transcript mirror.
    expect(spanEnd).toMatch(/slice\(0,\s*500\)/);
  });

  it('renders the excerpt and tool names into the feed text', () => {
    const block = dashboardSrc.slice(
      dashboardSrc.indexOf('const telemetryObjToTurnSummary'),
      dashboardSrc.indexOf('const parseRuntimeWorkspaceActivity'),
    );
    expect(block).toContain('assistantExcerpt');
    expect(block).toContain('assistant_excerpt');
    expect(block).toContain('tool_names');
    expect(block).toContain('no tools');
    expect(dashboardSrc).toContain('telemetryObjToTurnSummary');
    expect(dashboardSrc).toContain('if (!isK8sAgent(agent))');
  });
});
