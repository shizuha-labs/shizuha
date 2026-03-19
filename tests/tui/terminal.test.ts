import { afterEach, describe, expect, it } from 'vitest';
import { isTmuxSession, shouldAnimateTUI, shouldUseSynchronizedOutput } from '../../src/tui/utils/terminal.js';

const ORIGINAL_TMUX = process.env['TMUX'];
const ORIGINAL_ANIM = process.env['SHIZUHA_TUI_ANIMATIONS'];
const ORIGINAL_SYNC = process.env['SHIZUHA_SYNC_OUTPUT'];

function restoreEnv(): void {
  if (ORIGINAL_TMUX == null) delete process.env['TMUX'];
  else process.env['TMUX'] = ORIGINAL_TMUX;
  if (ORIGINAL_ANIM == null) delete process.env['SHIZUHA_TUI_ANIMATIONS'];
  else process.env['SHIZUHA_TUI_ANIMATIONS'] = ORIGINAL_ANIM;
  if (ORIGINAL_SYNC == null) delete process.env['SHIZUHA_SYNC_OUTPUT'];
  else process.env['SHIZUHA_SYNC_OUTPUT'] = ORIGINAL_SYNC;
}

afterEach(() => {
  restoreEnv();
});

describe('terminal capabilities', () => {
  it('defaults to animations on, sync off in tmux', () => {
    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0';
    delete process.env['SHIZUHA_TUI_ANIMATIONS'];
    delete process.env['SHIZUHA_SYNC_OUTPUT'];

    expect(isTmuxSession()).toBe(true);
    expect(shouldAnimateTUI()).toBe(true);
    expect(shouldUseSynchronizedOutput()).toBe(false);
  });

  it('defaults to full mode outside tmux', () => {
    delete process.env['TMUX'];
    delete process.env['SHIZUHA_TUI_ANIMATIONS'];
    delete process.env['SHIZUHA_SYNC_OUTPUT'];

    expect(isTmuxSession()).toBe(false);
    expect(shouldAnimateTUI()).toBe(true);
    expect(shouldUseSynchronizedOutput()).toBe(true);
  });

  it('respects explicit env overrides', () => {
    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0';
    process.env['SHIZUHA_TUI_ANIMATIONS'] = '1';
    process.env['SHIZUHA_SYNC_OUTPUT'] = 'true';

    expect(shouldAnimateTUI()).toBe(true);
    expect(shouldUseSynchronizedOutput()).toBe(true);
  });
});
