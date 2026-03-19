import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoReplyEngine } from '../../src/gateway/auto-reply.js';
import type { AutoReplyRule } from '../../src/gateway/auto-reply.js';
import type { InboundMessage, ChannelType } from '../../src/gateway/types.js';

// ── Helpers ──

function makeMsg(
  content: string | unknown,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    id: 'msg-1',
    channelId: 'ch-1',
    channelType: 'http' as ChannelType,
    threadId: 'thread-1',
    userId: 'user-1',
    userName: 'Alice',
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeRule(overrides: Partial<AutoReplyRule> = {}): AutoReplyRule {
  return {
    pattern: 'hello',
    response: 'Hi there!',
    caseSensitive: false,
    priority: 0,
    ...overrides,
  };
}

// ── Tests ──

describe('AutoReplyEngine', () => {
  // ── Exact string matching ──

  describe('exact string matching', () => {
    it('matches exact string (case insensitive by default)', () => {
      const engine = new AutoReplyEngine([makeRule({ pattern: 'hello', response: 'Hi!' })]);
      expect(engine.check(makeMsg('hello'))).toBe('Hi!');
      expect(engine.check(makeMsg('HELLO'))).toBe('Hi!');
      expect(engine.check(makeMsg('Hello'))).toBe('Hi!');
      expect(engine.check(makeMsg('hElLo'))).toBe('Hi!');
    });

    it('does not match partial strings', () => {
      const engine = new AutoReplyEngine([makeRule({ pattern: 'hello', response: 'Hi!' })]);
      expect(engine.check(makeMsg('hello world'))).toBeNull();
      expect(engine.check(makeMsg('say hello'))).toBeNull();
    });

    it('trims whitespace before matching', () => {
      const engine = new AutoReplyEngine([makeRule({ pattern: 'hello', response: 'Hi!' })]);
      expect(engine.check(makeMsg('  hello  '))).toBe('Hi!');
    });
  });

  // ── Case sensitive mode ──

  describe('case sensitive mode', () => {
    it('only matches exact case when caseSensitive is true', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'Hello', response: 'Hi!', caseSensitive: true }),
      ]);
      expect(engine.check(makeMsg('Hello'))).toBe('Hi!');
      expect(engine.check(makeMsg('hello'))).toBeNull();
      expect(engine.check(makeMsg('HELLO'))).toBeNull();
    });
  });

  // ── Glob pattern matching ──

  describe('glob pattern matching', () => {
    it('matches wildcard patterns with *', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello*', response: 'Greeting detected!' }),
      ]);
      expect(engine.check(makeMsg('hello'))).toBe('Greeting detected!');
      expect(engine.check(makeMsg('hello world'))).toBe('Greeting detected!');
      expect(engine.check(makeMsg('hello there friend'))).toBe('Greeting detected!');
    });

    it('matches wildcards at beginning', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '*bye', response: 'Goodbye!' }),
      ]);
      expect(engine.check(makeMsg('bye'))).toBe('Goodbye!');
      expect(engine.check(makeMsg('goodbye'))).toBe('Goodbye!');
      expect(engine.check(makeMsg('see you bye'))).toBe('Goodbye!');
    });

    it('matches wildcards in the middle', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello*world', response: 'Match!' }),
      ]);
      expect(engine.check(makeMsg('hello world'))).toBe('Match!');
      expect(engine.check(makeMsg('helloworld'))).toBe('Match!');
      expect(engine.check(makeMsg('hello beautiful world'))).toBe('Match!');
    });

    it('glob matching is case insensitive by default', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'Hello*', response: 'Match!' }),
      ]);
      expect(engine.check(makeMsg('hello world'))).toBe('Match!');
      expect(engine.check(makeMsg('HELLO WORLD'))).toBe('Match!');
    });

    it('glob matching is case sensitive when specified', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'Hello*', response: 'Match!', caseSensitive: true }),
      ]);
      expect(engine.check(makeMsg('Hello World'))).toBe('Match!');
      expect(engine.check(makeMsg('hello world'))).toBeNull();
    });
  });

  // ── Regex pattern matching ──

  describe('regex pattern matching', () => {
    it('matches regex patterns wrapped in /.../', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '/^\\d+$/', response: 'That is a number!' }),
      ]);
      expect(engine.check(makeMsg('123'))).toBe('That is a number!');
      expect(engine.check(makeMsg('456789'))).toBe('That is a number!');
      expect(engine.check(makeMsg('12abc'))).toBeNull();
      expect(engine.check(makeMsg('not a number'))).toBeNull();
    });

    it('supports regex flags', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '/^(hi|hey|hello)$/i', response: 'Greeting!', caseSensitive: true }),
      ]);
      expect(engine.check(makeMsg('hi'))).toBe('Greeting!');
      expect(engine.check(makeMsg('HI'))).toBe('Greeting!');
      expect(engine.check(makeMsg('hey'))).toBe('Greeting!');
      expect(engine.check(makeMsg('hello'))).toBe('Greeting!');
      expect(engine.check(makeMsg('howdy'))).toBeNull();
    });

    it('adds i flag automatically when not caseSensitive and no i flag', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '/^hello$/', response: 'Match!', caseSensitive: false }),
      ]);
      // caseSensitive=false should auto-add 'i' flag
      expect(engine.check(makeMsg('HELLO'))).toBe('Match!');
      expect(engine.check(makeMsg('hello'))).toBe('Match!');
    });

    it('does not duplicate i flag if already present', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '/^hello$/i', response: 'Match!', caseSensitive: false }),
      ]);
      // Should still work even though i flag was already present
      expect(engine.check(makeMsg('HELLO'))).toBe('Match!');
    });

    it('invalid regex falls back to literal match', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '/[invalid/', response: 'Matched!' }),
      ]);
      // Invalid regex, treated as literal "/[invalid/"
      expect(engine.check(makeMsg('/[invalid/'))).toBe('Matched!');
    });
  });

  // ── Channel type filtering ──

  describe('channel type filtering', () => {
    it('rule with channels filter only matches specified channel types', () => {
      const engine = new AutoReplyEngine([
        makeRule({
          pattern: 'hello',
          response: 'Hi from Telegram!',
          channels: ['telegram'],
        }),
      ]);
      expect(engine.check(makeMsg('hello', { channelType: 'telegram' }))).toBe(
        'Hi from Telegram!',
      );
      expect(engine.check(makeMsg('hello', { channelType: 'http' }))).toBeNull();
      expect(engine.check(makeMsg('hello', { channelType: 'discord' }))).toBeNull();
    });

    it('rule without channels filter matches all channel types', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi!' }),
      ]);
      expect(engine.check(makeMsg('hello', { channelType: 'telegram' }))).toBe('Hi!');
      expect(engine.check(makeMsg('hello', { channelType: 'http' }))).toBe('Hi!');
      expect(engine.check(makeMsg('hello', { channelType: 'discord' }))).toBe('Hi!');
    });

    it('rule with empty channels array matches all channel types', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi!', channels: [] }),
      ]);
      expect(engine.check(makeMsg('hello', { channelType: 'telegram' }))).toBe('Hi!');
      expect(engine.check(makeMsg('hello', { channelType: 'http' }))).toBe('Hi!');
    });

    it('rule with multiple channels matches any of them', () => {
      const engine = new AutoReplyEngine([
        makeRule({
          pattern: 'hello',
          response: 'Hi!',
          channels: ['telegram', 'discord'],
        }),
      ]);
      expect(engine.check(makeMsg('hello', { channelType: 'telegram' }))).toBe('Hi!');
      expect(engine.check(makeMsg('hello', { channelType: 'discord' }))).toBe('Hi!');
      expect(engine.check(makeMsg('hello', { channelType: 'http' }))).toBeNull();
    });
  });

  // ── Priority ordering ──

  describe('priority ordering', () => {
    it('higher priority rules are checked first', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Low priority', priority: 1 }),
        makeRule({ pattern: 'hello', response: 'High priority', priority: 10 }),
        makeRule({ pattern: 'hello', response: 'Medium priority', priority: 5 }),
      ]);
      expect(engine.check(makeMsg('hello'))).toBe('High priority');
    });

    it('same priority preserves original order', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'First', priority: 0 }),
        makeRule({ pattern: 'hello', response: 'Second', priority: 0 }),
      ]);
      // Both have priority 0, stable sort should keep original order
      expect(engine.check(makeMsg('hello'))).toBe('First');
    });
  });

  // ── Template variable expansion ──

  describe('template variable expansion', () => {
    it('expands {user} to userName', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi {user}!' }),
      ]);
      expect(engine.check(makeMsg('hello', { userName: 'Alice' }))).toBe('Hi Alice!');
    });

    it('expands {user} to userId when userName is not set', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi {user}!' }),
      ]);
      expect(engine.check(makeMsg('hello', { userName: undefined, userId: 'user-42' }))).toBe(
        'Hi user-42!',
      );
    });

    it('expands {user} to "there" when neither userName nor userId is set', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi {user}!' }),
      ]);
      // userId defaults to undefined via override
      const msg = makeMsg('hello', { userName: undefined, userId: undefined as unknown as string });
      expect(engine.check(msg)).toBe('Hi there!');
    });

    it('expands {channel} to channelType', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'You are on {channel}' }),
      ]);
      expect(engine.check(makeMsg('hello', { channelType: 'telegram' }))).toBe(
        'You are on telegram',
      );
    });

    it('expands {time} to current time', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'time', response: 'The time is {time}' }),
      ]);
      const result = engine.check(makeMsg('time'));
      expect(result).not.toBeNull();
      // Time should be in HH:MM AM/PM format
      expect(result).toMatch(/The time is \d{2}:\d{2}\s*(AM|PM)/);
    });

    it('expands multiple template variables', () => {
      const engine = new AutoReplyEngine([
        makeRule({
          pattern: 'info',
          response: '{user} on {channel} at {time}',
        }),
      ]);
      const result = engine.check(
        makeMsg('info', { userName: 'Bob', channelType: 'discord' }),
      );
      expect(result).toMatch(/^Bob on discord at \d{2}:\d{2}\s*(AM|PM)$/);
    });
  });

  // ── No match ──

  describe('no match', () => {
    it('returns null when no rules match', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi!' }),
      ]);
      expect(engine.check(makeMsg('goodbye'))).toBeNull();
    });

    it('returns null when there are no rules', () => {
      const engine = new AutoReplyEngine([]);
      expect(engine.check(makeMsg('hello'))).toBeNull();
    });

    it('returns null for empty string content', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '', response: 'Match!' }),
      ]);
      expect(engine.check(makeMsg(''))).toBeNull();
    });

    it('returns null for whitespace-only content', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi!' }),
      ]);
      expect(engine.check(makeMsg('   '))).toBeNull();
    });
  });

  // ── Non-string content ──

  describe('non-string content', () => {
    it('returns null for object content', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi!' }),
      ]);
      expect(engine.check(makeMsg({ type: 'image', url: 'https://example.com/img.png' }))).toBeNull();
    });

    it('returns null for array content', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi!' }),
      ]);
      expect(engine.check(makeMsg([1, 2, 3]))).toBeNull();
    });

    it('returns null for numeric content', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '42', response: 'The answer!' }),
      ]);
      expect(engine.check(makeMsg(42))).toBeNull();
    });

    it('returns null for null content', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi!' }),
      ]);
      expect(engine.check(makeMsg(null))).toBeNull();
    });

    it('returns null for undefined content', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: 'hello', response: 'Hi!' }),
      ]);
      expect(engine.check(makeMsg(undefined))).toBeNull();
    });
  });

  // ── Multiple rules, first match wins ──

  describe('multiple rules, first match wins', () => {
    it('returns the first matching rule response', () => {
      const engine = new AutoReplyEngine([
        makeRule({ pattern: '/^h/', response: 'Starts with h', priority: 0 }),
        makeRule({ pattern: 'hello', response: 'Exact hello', priority: 0 }),
      ]);
      // /^h/ is checked first (same priority, original order preserved)
      expect(engine.check(makeMsg('hello'))).toBe('Starts with h');
    });

    it('falls through to next rule if channel filter blocks first', () => {
      const engine = new AutoReplyEngine([
        makeRule({
          pattern: 'hello',
          response: 'Telegram only',
          channels: ['telegram'],
          priority: 10,
        }),
        makeRule({
          pattern: 'hello',
          response: 'General response',
          priority: 5,
        }),
      ]);
      // On HTTP, first rule is skipped due to channel filter, second matches
      expect(engine.check(makeMsg('hello', { channelType: 'http' }))).toBe('General response');
      // On Telegram, first rule matches
      expect(engine.check(makeMsg('hello', { channelType: 'telegram' }))).toBe('Telegram only');
    });
  });
});
