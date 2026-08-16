/**
 * Bench cells run `shizuha exec`, which uses the duplicated loop in
 * src/index.ts — not runAgent() in loop.ts. A continue-only-in-TUI fix
 * (db55df0b / 6a963cb) still aborted Qwen 16k-think cells at ~505s.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname!, '../..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('exec/android/server share the autonomous max_tokens continue helper', () => {
  const files = [
    'src/index.ts',
    'src/android-entry.ts',
    'src/server.ts',
    'src/agent/loop.ts',
  ];

  it('imports shouldContinueAutonomousMaxTokens in every agent loop', () => {
    for (const rel of files) {
      const src = readSrc(rel);
      expect(src, rel).toContain('shouldContinueAutonomousMaxTokens');
      expect(src, rel).toContain('AUTONOMOUS_MAX_TOKENS_CONTINUE_PROMPT');
    }
  });

  it('does not refuse exec replay before the continue helper', () => {
    const src = readSrc('src/index.ts');
    const helper = src.indexOf('shouldContinueAutonomousMaxTokens({');
    const refuse = src.indexOf('SCLI exec: model turn ended incomplete; refusing automatic replay');
    expect(helper).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(helper);
  });

  it('does not gate the helper on empty visible text', () => {
    const helper = readSrc('src/agent/incomplete-turn.ts');
    const fn = helper.slice(helper.indexOf('export function shouldContinueAutonomousMaxTokens'));
    expect(fn).toContain('reasoningText.trim().length > 0');
    expect(fn).not.toContain('visibleText');
    expect(fn).not.toContain('strippedCheck');
    expect(fn).not.toContain('hasVisibleAssistantText');
  });
});
