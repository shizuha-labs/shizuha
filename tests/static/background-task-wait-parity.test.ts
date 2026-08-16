import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const autonomousLoop = readFileSync(resolve(__dirname, '../../src/agent/loop.ts'), 'utf8');
const execLoop = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');
const subAgent = readFileSync(resolve(__dirname, '../../src/agent/sub-agent.ts'), 'utf8');

describe('background task wait parity', () => {
  it.each([
    ['autonomous loop', autonomousLoop],
    ['exec copied loop', execLoop],
  ])('%s delegates wait-only continuation to the shared bounded controller', (_name, source) => {
    expect(source).toContain('BackgroundTaskWaitController');
    expect(source).toMatch(/new BackgroundTaskWaitController\([^;]*\)/);
    expect(source).toContain('decideBackgroundTaskContinuation({');
    expect(source).toContain('toolCallCount: result.toolCalls.length');
    expect(source).toContain('assistantContent: result.assistantMessage.content');
    expect(source).toContain("backgroundAction === 'continue'");
    expect(source).toContain("backgroundAction === 'nudge'");
    expect(source).toContain('backgroundTaskWait.dispose()');
  });

  it('propagates sub-agent cancellation into the autonomous loop config', () => {
    expect(subAgent).toContain('abortSignal: options.signal');
  });
});
