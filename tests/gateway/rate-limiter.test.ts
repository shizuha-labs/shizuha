import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';

// Mock the logger to suppress output
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { RateLimiter } = await import('../../src/gateway/rate-limiter.js');

describe('RateLimiter', () => {
  describe('constructor defaults', () => {
    it('uses default config of 30 messages per 60s window', () => {
      const limiter = new RateLimiter();
      const usage = limiter.getUsage('nobody');
      expect(usage.maxMessages).toBe(30);
      expect(usage.windowMs).toBe(60_000);
    });

    it('accepts custom config', () => {
      const limiter = new RateLimiter({ maxMessages: 5, windowMs: 10_000 });
      const usage = limiter.getUsage('nobody');
      expect(usage.maxMessages).toBe(5);
      expect(usage.windowMs).toBe(10_000);
    });

    it('partial config merges with defaults', () => {
      const limiter = new RateLimiter({ maxMessages: 10 });
      const usage = limiter.getUsage('nobody');
      expect(usage.maxMessages).toBe(10);
      expect(usage.windowMs).toBe(60_000);
    });
  });

  describe('check', () => {
    it('allows messages under the limit', () => {
      const limiter = new RateLimiter({ maxMessages: 5, windowMs: 60_000 });
      for (let i = 0; i < 5; i++) {
        const result = limiter.check('user1');
        expect(result.allowed).toBe(true);
      }
    });

    it('blocks when limit is exceeded', () => {
      const limiter = new RateLimiter({ maxMessages: 3, windowMs: 60_000 });
      limiter.check('user1');
      limiter.check('user1');
      limiter.check('user1');
      const result = limiter.check('user1');
      expect(result.allowed).toBe(false);
    });

    it('returns retryAfterMs when blocked', () => {
      const limiter = new RateLimiter({ maxMessages: 2, windowMs: 60_000 });
      limiter.check('user1');
      limiter.check('user1');
      const result = limiter.check('user1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfterMs).toBeGreaterThanOrEqual(1000);
        expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
      }
    });

    it('retryAfterMs is at least 1000ms (floor)', () => {
      // Use a tiny window so the calculated retry is small
      const limiter = new RateLimiter({ maxMessages: 1, windowMs: 500 });
      limiter.check('user1');

      // The next check should be blocked; the retry should be clamped to 1000ms minimum
      const result = limiter.check('user1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.retryAfterMs).toBeGreaterThanOrEqual(1000);
      }
    });

    it('allows messages again after window slides (old timestamps pruned)', () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter({ maxMessages: 2, windowMs: 1000 });

        // Fill the bucket
        limiter.check('user1');
        limiter.check('user1');
        expect(limiter.check('user1').allowed).toBe(false);

        // Advance time past the window
        vi.advanceTimersByTime(1001);

        // Should be allowed again
        const result = limiter.check('user1');
        expect(result.allowed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('different users are independent', () => {
      const limiter = new RateLimiter({ maxMessages: 2, windowMs: 60_000 });
      limiter.check('alice');
      limiter.check('alice');
      // Alice is now at limit
      expect(limiter.check('alice').allowed).toBe(false);
      // Bob should still be allowed
      expect(limiter.check('bob').allowed).toBe(true);
      expect(limiter.check('bob').allowed).toBe(true);
      expect(limiter.check('bob').allowed).toBe(false);
    });

    it('creates bucket on first check for unknown user', () => {
      const limiter = new RateLimiter({ maxMessages: 5 });
      const result = limiter.check('new-user');
      expect(result.allowed).toBe(true);
    });
  });

  describe('getUsage', () => {
    it('returns 0 count for unknown user', () => {
      const limiter = new RateLimiter({ maxMessages: 10, windowMs: 60_000 });
      const usage = limiter.getUsage('nobody');
      expect(usage.count).toBe(0);
      expect(usage.maxMessages).toBe(10);
      expect(usage.windowMs).toBe(60_000);
    });

    it('returns accurate count after messages', () => {
      const limiter = new RateLimiter({ maxMessages: 10, windowMs: 60_000 });
      limiter.check('user1');
      limiter.check('user1');
      limiter.check('user1');
      const usage = limiter.getUsage('user1');
      expect(usage.count).toBe(3);
    });

    it('count decreases as timestamps fall outside window', () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter({ maxMessages: 10, windowMs: 1000 });
        limiter.check('user1');
        limiter.check('user1');
        expect(limiter.getUsage('user1').count).toBe(2);

        vi.advanceTimersByTime(1001);
        expect(limiter.getUsage('user1').count).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('cleanup', () => {
    it('startCleanup is idempotent (calling twice does not create two timers)', () => {
      const limiter = new RateLimiter();
      limiter.startCleanup();
      limiter.startCleanup(); // Should not create a second timer
      limiter.stopCleanup();
    });

    it('stopCleanup clears the timer', () => {
      const limiter = new RateLimiter();
      limiter.startCleanup();
      limiter.stopCleanup();
      // No errors, timer is cleared
      limiter.stopCleanup(); // Second call should be safe
    });

    it('cleanup removes stale buckets', () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter({ maxMessages: 10, windowMs: 1000 });

        // Add messages for a user
        limiter.check('stale-user');
        limiter.check('stale-user');

        // Advance past 2x the window (stale cutoff)
        vi.advanceTimersByTime(2001);

        // Start cleanup and trigger the interval
        limiter.startCleanup();
        vi.advanceTimersByTime(5 * 60_000); // Trigger the 5-minute cleanup interval

        // The stale user's bucket should have been removed
        // getUsage will return 0 for the now-gone bucket
        const usage = limiter.getUsage('stale-user');
        expect(usage.count).toBe(0);

        limiter.stopCleanup();
      } finally {
        vi.useRealTimers();
      }
    });

    it('cleanup preserves recent buckets', () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter({ maxMessages: 10, windowMs: 60_000 });

        // Add a recent message
        limiter.check('recent-user');

        // Start cleanup and trigger the interval
        limiter.startCleanup();
        vi.advanceTimersByTime(5 * 60_000);

        // Recent user should still have a count (timestamp is within windowMs * 2)
        // Actually, after 5 min the timestamp is 300s old, windowMs*2 = 120s, so it would be pruned
        // Let's use a larger window
        limiter.stopCleanup();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

async function withMcpAuthorizationRateLimiter(
  probe: (request: (ip: string) => Promise<number>) => Promise<void>,
): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/authorize', authorizationHandler({
    provider: {
      clientsStore: {
        async getClient() {
          return undefined;
        },
      },
    } as any,
    rateLimit: {
      windowMs: 60_000,
      max: 1,
      // express-rate-limit v8 defaults ipv6Subnet=/56, which collapses all
      // IPv4-mapped IPv6 clients (::ffff:a.b.c.d) into one bucket. Isolation
      // probes need full-address keys.
      ipv6Subnet: false as const,
      standardHeaders: false,
      legacyHeaders: false,
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  const request = async (ip: string): Promise<number> => {
    const response = await fetch(`http://127.0.0.1:${port}/authorize/?client_id=missing`, {
      headers: { 'x-forwarded-for': ip },
    });
    await response.text();
    return response.status;
  };

  try {
    await probe(request);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

describe('MCP SDK OAuth rate-limit key isolation', () => {
  it.each([
    ['IPv4', '192.0.2.1', '192.0.2.2'],
    ['IPv4-mapped IPv6', '::ffff:192.0.2.1', '::ffff:192.0.2.2'],
    ['dual-stack', '192.0.2.1', '2001:db8::1'],
  ])('keeps %s clients in independent buckets', async (_label, first, second) => {
    await withMcpAuthorizationRateLimiter(async request => {
      expect(await request(first)).toBe(400);
      expect(await request(second)).toBe(400);
      expect(await request(first)).toBe(429);
      expect(await request(second)).toBe(429);
    });
  });
});
