import { describe, expect, it } from 'vitest';
import { buildBridgeIdentityPrompt } from '../../src/prompt/bridge-identity.js';
import { buildClaudeSpawnArgs } from '../../src/claude-bridge/index.js';
import { buildOpenClawAgentParams } from '../../src/openclaw-bridge/index.js';

describe('bridge identity prompt', () => {
  it('derives a stable identity block from agent metadata and appends custom instructions', () => {
    const prompt = buildBridgeIdentityPrompt({
      name: 'Sara',
      username: 'sara',
      role: 'Engineer',
      skills: ['coding', 'debugging'],
      personalityTraits: { tone: 'direct', style: 'pragmatic' },
    }, 'Write clean code.');

    expect(prompt).toContain('You are Sara, a Shizuha agent.');
    expect(prompt).toContain('Your username is sara.');
    expect(prompt).toContain('Your role is Engineer.');
    expect(prompt).toContain('Do not present yourself as Claude Code, Codex, OpenClaw');
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('- coding');
    expect(prompt).toContain('## Personality Traits');
    expect(prompt).toContain('- style: pragmatic');
    expect(prompt).toContain('## Agent Instructions');
    expect(prompt).toContain('Write clean code.');
  });

  it('still produces identity guidance when no custom prompt exists', () => {
    const prompt = buildBridgeIdentityPrompt({
      name: 'Claw',
      username: 'claw',
      role: 'engineer',
      skills: [],
      personalityTraits: {},
    });

    expect(prompt).toContain('You are Claw, a Shizuha agent.');
    expect(prompt).not.toContain('## Agent Instructions');
  });

  it('handles undefined skills and personalityTraits (local agents)', () => {
    // Local agents from agents.json may not have skills/personalityTraits fields
    const prompt = buildBridgeIdentityPrompt({
      name: 'LocalBot',
      username: 'localbot',
      role: 'agent',
      skills: undefined as any,
      personalityTraits: undefined as any,
    });

    expect(prompt).toContain('You are LocalBot, a Shizuha agent.');
    expect(prompt).not.toContain('## Skills');
    expect(prompt).not.toContain('## Personality Traits');
  });
});

describe('OpenClaw agent params', () => {
  it('forwards the bridge identity prompt via extraSystemPrompt', () => {
    const params = buildOpenClawAgentParams({
      message: 'hello',
      threadId: 'thread-123',
      thinkingLevel: 'high',
      contextPrompt: 'You are Claw.',
    });

    expect(params).toMatchObject({
      message: 'hello',
      idempotencyKey: 'thread-123',
      sessionKey: 'agent:main:main',
      timeout: 600_000,
      thinking: 'high',
      extraSystemPrompt: 'You are Claw.',
    });
  });

  it('omits extraSystemPrompt when no bridge prompt was provided', () => {
    const params = buildOpenClawAgentParams({
      message: 'hello',
      threadId: 'thread-123',
    });

    expect(params['extraSystemPrompt']).toBeUndefined();
  });
});

describe('Claude bridge spawn args', () => {
  it('resumes when a stored session id exists', () => {
    const args = buildClaudeSpawnArgs({
      model: 'claude-sonnet-4-6',
      storedSessionId: '123e4567-e89b-12d3-a456-426614174000',
      contextPrompt: 'You are Sara.',
    });

    expect(args).toContain('--resume');
    expect(args).toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(args).toContain('--append-system-prompt');
  });

  it('starts fresh when no stored session id exists', () => {
    const args = buildClaudeSpawnArgs({
      model: 'claude-sonnet-4-6',
      contextPrompt: 'You are Sara.',
    });

    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
    expect(args).toContain('--append-system-prompt');
  });
});
