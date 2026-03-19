import { describe, it, expect, vi, afterEach } from 'vitest';
import { setAskUserCallback, askUserTool } from '../../src/tools/builtin/ask-user.js';

describe('ask-user callback injection', () => {
  afterEach(() => {
    setAskUserCallback(null);
  });

  it('uses injected callback when set', async () => {
    const callback = vi.fn().mockResolvedValue('user response from TUI');
    setAskUserCallback(callback);

    const result = await askUserTool.execute(
      { question: 'What is your name?' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(callback).toHaveBeenCalledWith('What is your name?');
    expect(result.content).toBe('user response from TUI');
    expect(result.isError).toBeFalsy();
  });

  it('returns [No response] when callback returns empty string', async () => {
    const callback = vi.fn().mockResolvedValue('  ');
    setAskUserCallback(callback);

    const result = await askUserTool.execute(
      { question: 'Hello?' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(result.content).toBe('[No response]');
  });

  it('falls through to non-interactive mode when callback not set', async () => {
    // Don't set callback, and stdin is not TTY in test env
    setAskUserCallback(null);
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const result = await askUserTool.execute(
        { question: 'test' },
        { cwd: '/tmp', sessionId: 'test' },
      );
      expect(result.content).toContain('Non-interactive');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('can be set and unset multiple times', async () => {
    const cb1 = vi.fn().mockResolvedValue('response 1');
    const cb2 = vi.fn().mockResolvedValue('response 2');

    setAskUserCallback(cb1);
    let result = await askUserTool.execute(
      { question: 'q1' },
      { cwd: '/tmp', sessionId: 'test' },
    );
    expect(result.content).toBe('response 1');

    setAskUserCallback(cb2);
    result = await askUserTool.execute(
      { question: 'q2' },
      { cwd: '/tmp', sessionId: 'test' },
    );
    expect(result.content).toBe('response 2');

    setAskUserCallback(null);
    // Now falls through to non-interactive
  });
});
