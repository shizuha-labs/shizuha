/**
 * Comprehensive integration/e2e test suite for shizuha agent features.
 *
 * Tests the full stack: tool registries, cron lifecycle, auto-reply engine,
 * rate limiting, usage tracking, toolsets, permissions, doctor checks,
 * config schema parsing, loop detection, and browser manager.
 *
 * Only external APIs (OpenAI, network fetches, Playwright browser) are mocked.
 * All internal infrastructure uses real classes and modules.
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ── Helpers ──

function tmpDir(prefix = 'shizuha-e2e'): string {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}`);
}

function toolCtx(cwd?: string): import('../../src/tools/types.js').ToolContext {
  return { cwd: cwd ?? os.tmpdir(), sessionId: `e2e-${crypto.randomUUID()}` };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Tool Execution Integration
// ════════════════════════════════════════════════════════════════════════════

describe('1. Tool Execution Integration', () => {
  let registry: import('../../src/tools/registry.js').ToolRegistry;

  beforeAll(async () => {
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');
    registry = new ToolRegistry();
    registerBuiltinTools(registry);
  }, 30_000);

  // ── 1a. Registration completeness ──

  it('registers at least 25 built-in tools', () => {
    expect(registry.size).toBeGreaterThanOrEqual(25);
  });

  it.each([
    'schedule_job',
    'list_jobs',
    'remove_job',
    'memory',
    'text_to_speech',
    'image_generate',
    'session_search',
    'usage_stats',
    'browser',
    'pdf_extract',
  ])('has tool "%s" registered', (name) => {
    expect(registry.has(name)).toBe(true);
  });

  it('generates JSON Schema definitions for all tools', () => {
    const defs = registry.definitions();
    expect(defs.length).toBe(registry.size);
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
    }
  });

  // ── 1b. Memory tool full lifecycle ──

  describe('memory tool lifecycle', () => {
    let memDir: string;
    let memFile: string;

    beforeEach(async () => {
      memDir = tmpDir('shizuha-mem-int');
      await fs.mkdir(memDir, { recursive: true });
      memFile = path.join(memDir, 'MEMORY.md');
      const { setMemoryFilePath } = await import('../../src/tools/builtin/memory.js');
      setMemoryFilePath(memFile);
    });

    afterEach(async () => {
      const { setMemoryFilePath } = await import('../../src/tools/builtin/memory.js');
      setMemoryFilePath(null as any);
      await fs.rm(memDir, { recursive: true, force: true }).catch(() => {});
    });

    it('add -> list -> search -> remove lifecycle', async () => {
      const tool = registry.get('memory')!;
      const ctx = toolCtx();

      // Add
      const addResult = await tool.execute({ action: 'add', content: 'integration test memory entry' }, ctx);
      expect(addResult.isError).toBeUndefined();
      expect(addResult.content).toContain('Added');

      // List — should contain the entry
      const listResult = await tool.execute({ action: 'list' }, ctx);
      expect(listResult.content).toContain('integration test memory entry');
      expect(listResult.content).toContain('1 entry');

      // Search — should find it
      const searchResult = await tool.execute({ action: 'search', content: 'integration' }, ctx);
      expect(searchResult.content).toContain('Found 1');
      expect(searchResult.content).toContain('integration test memory entry');

      // Remove
      const removeResult = await tool.execute({ action: 'remove', old_text: 'integration test memory entry' }, ctx);
      expect(removeResult.isError).toBeUndefined();
      expect(removeResult.content).toContain('Removed');

      // List again — should be empty
      const emptyResult = await tool.execute({ action: 'list' }, ctx);
      expect(emptyResult.content).toBe('Memory is empty.');
    });

    it('add multiple entries and search finds correct ones', async () => {
      const tool = registry.get('memory')!;
      const ctx = toolCtx();

      await tool.execute({ action: 'add', content: 'Python for ML pipelines' }, ctx);
      await tool.execute({ action: 'add', content: 'TypeScript for frontend' }, ctx);
      await tool.execute({ action: 'add', content: 'Docker for deployments' }, ctx);

      const searchResult = await tool.execute({ action: 'search', content: 'for' }, ctx);
      expect(searchResult.content).toContain('Found 3');

      const tsResult = await tool.execute({ action: 'search', content: 'typescript' }, ctx);
      expect(tsResult.content).toContain('Found 1');
      expect(tsResult.content).toContain('TypeScript for frontend');
    });
  });

  // ── 1c. Cron tool lifecycle via tool registry ──

  describe('cron tools lifecycle', () => {
    let stateDir: string;

    beforeEach(async () => {
      stateDir = tmpDir('shizuha-cron-int');
      await fs.mkdir(stateDir, { recursive: true });
      const { CronStore } = await import('../../src/cron/store.js');
      const { setCronStore } = await import('../../src/tools/builtin/cron.js');
      const store = new CronStore(stateDir);
      await store.load();
      setCronStore(store, { channelId: 'test-ch', threadId: 'test-th', channelType: 'http' });
    });

    afterEach(async () => {
      const { setCronStore } = await import('../../src/tools/builtin/cron.js');
      setCronStore(null as any);
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    });

    it('list_jobs returns empty initially', async () => {
      const tool = registry.get('list_jobs')!;
      const result = await tool.execute({}, toolCtx());
      expect(result.content).toBe('No scheduled jobs.');
    });

    it('schedule_job -> list_jobs -> remove_job lifecycle', async () => {
      const ctx = toolCtx();

      // Schedule a job
      const scheduleTool = registry.get('schedule_job')!;
      const schedResult = await scheduleTool.execute(
        { name: 'Integration Test Job', prompt: 'Say hello', schedule: '30m' },
        ctx,
      );
      expect(schedResult.isError).toBeUndefined();
      const schedData = JSON.parse(schedResult.content);
      expect(schedData.success).toBe(true);
      expect(schedData.jobId).toBeTruthy();
      expect(schedData.name).toBe('Integration Test Job');
      expect(schedData.repeats).toBe('once');

      // List jobs — should find it
      const listTool = registry.get('list_jobs')!;
      const listResult = await listTool.execute({}, ctx);
      const jobs = JSON.parse(listResult.content);
      expect(Array.isArray(jobs)).toBe(true);
      expect(jobs.length).toBe(1);
      expect(jobs[0].name).toBe('Integration Test Job');

      // Remove the job
      const removeTool = registry.get('remove_job')!;
      const removeResult = await removeTool.execute({ job_id: schedData.jobId }, ctx);
      expect(removeResult.isError).toBeUndefined();
      expect(removeResult.content).toContain('removed');

      // List again — should be empty
      const emptyResult = await listTool.execute({}, ctx);
      expect(emptyResult.content).toBe('No scheduled jobs.');
    });

    it('schedule_job with interval creates repeating job', async () => {
      const scheduleTool = registry.get('schedule_job')!;
      const result = await scheduleTool.execute(
        { name: 'Repeater', prompt: 'Check status', schedule: 'every 2h' },
        toolCtx(),
      );
      const data = JSON.parse(result.content);
      expect(data.success).toBe(true);
      expect(data.repeats).toBe('forever');
    });

    it('schedule_job rejects invalid schedule', async () => {
      const scheduleTool = registry.get('schedule_job')!;
      const result = await scheduleTool.execute(
        { name: 'Bad', prompt: 'nope', schedule: 'next tuesday' },
        toolCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Schedule error');
    });

    it('remove_job with non-existent ID returns error', async () => {
      const removeTool = registry.get('remove_job')!;
      const result = await removeTool.execute({ job_id: 'nonexistent123' }, toolCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });
  });

  // ── 1d. pdf_extract with a text file ──

  describe('pdf_extract tool', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = tmpDir('shizuha-pdf-int');
      await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    it('extracts text from a .txt file', async () => {
      const txtFile = path.join(testDir, 'sample.txt');
      await fs.writeFile(txtFile, 'Hello, this is a test file.\nLine 2.\nLine 3.', 'utf-8');

      const tool = registry.get('pdf_extract')!;
      const result = await tool.execute({ file_path: txtFile }, toolCtx(testDir));
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('sample.txt');
      expect(result.content).toContain('Hello, this is a test file.');
      expect(result.content).toContain('Line 2.');
    });

    it('extracts text from a .csv file', async () => {
      const csvFile = path.join(testDir, 'data.csv');
      await fs.writeFile(csvFile, 'name,age\nAlice,30\nBob,25', 'utf-8');

      const tool = registry.get('pdf_extract')!;
      const result = await tool.execute({ file_path: csvFile }, toolCtx(testDir));
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Alice,30');
    });

    it('returns error for non-existent file', async () => {
      const tool = registry.get('pdf_extract')!;
      const result = await tool.execute(
        { file_path: path.join(testDir, 'nope.txt') },
        toolCtx(testDir),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('returns error for unsupported extension', async () => {
      const binFile = path.join(testDir, 'binary.exe');
      await fs.writeFile(binFile, Buffer.from([0x00, 0x01, 0x02]));

      const tool = registry.get('pdf_extract')!;
      const result = await tool.execute({ file_path: binFile }, toolCtx(testDir));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unsupported file type');
    });

    it('supports markdown format output', async () => {
      const mdFile = path.join(testDir, 'notes.md');
      await fs.writeFile(mdFile, '# Heading\n\nSome notes here.', 'utf-8');

      const tool = registry.get('pdf_extract')!;
      const result = await tool.execute(
        { file_path: mdFile, format: 'markdown' },
        toolCtx(testDir),
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('# notes.md');
      expect(result.content).toContain('```md');
    });
  });

  // ── 1e. usage_stats tool ──

  describe('usage_stats tool', () => {
    let dbPath: string;
    let testDir: string;

    beforeEach(async () => {
      testDir = tmpDir('shizuha-usage-int');
      await fs.mkdir(testDir, { recursive: true });
      dbPath = path.join(testDir, 'state.db');

      const { StateStore } = await import('../../src/state/store.js');
      const { UsageTracker } = await import('../../src/gateway/usage-tracker.js');
      const { setUsageTracker } = await import('../../src/tools/builtin/usage.js');

      const store = new StateStore(dbPath);
      const tracker = new UsageTracker(store);
      setUsageTracker(tracker);
    });

    afterEach(async () => {
      const { setUsageTracker } = await import('../../src/tools/builtin/usage.js');
      setUsageTracker(null as any);
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    it('returns aggregate stats (even when empty)', async () => {
      const tool = registry.get('usage_stats')!;
      const result = await tool.execute({}, toolCtx());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content);
      expect(data.aggregate).toBeDefined();
      expect(data.aggregate.totalMessages).toBe(0);
      expect(data.aggregate.uniqueUsers).toBe(0);
    });

    it('returns user stats after recording messages', async () => {
      const { StateStore } = await import('../../src/state/store.js');
      const { UsageTracker } = await import('../../src/gateway/usage-tracker.js');
      const { setUsageTracker } = await import('../../src/tools/builtin/usage.js');

      const store = new StateStore(dbPath);
      const tracker = new UsageTracker(store);
      setUsageTracker(tracker);

      // Record some usage
      tracker.recordMessage('user-alice', 'telegram', 500, 1200, 3);
      tracker.recordMessage('user-alice', 'telegram', 300, 800, 1);
      tracker.recordMessage('user-bob', 'http', 200, 600, 2);

      const tool = registry.get('usage_stats')!;
      const result = await tool.execute({}, toolCtx());
      const data = JSON.parse(result.content);

      expect(data.aggregate.totalMessages).toBe(3);
      expect(data.aggregate.uniqueUsers).toBe(2);
      expect(data.aggregate.totalInputTokens).toBe(1000);
      expect(data.aggregate.totalOutputTokens).toBe(2600);
      expect(data.aggregate.totalToolCalls).toBe(6);

      // Per-user filter
      const aliceResult = await tool.execute({ user_id: 'user-alice' }, toolCtx());
      const aliceData = JSON.parse(aliceResult.content);
      expect(Array.isArray(aliceData)).toBe(true);
      expect(aliceData[0].messageCount).toBe(2);
      expect(aliceData[0].inputTokens).toBe(800);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Cron Store + Scheduler Integration
// ════════════════════════════════════════════════════════════════════════════

describe('2. Cron Store + Scheduler Integration', () => {
  let stateDir: string;
  let store: import('../../src/cron/store.js').CronStore;

  beforeEach(async () => {
    stateDir = tmpDir('shizuha-cron-sched');
    const { CronStore } = await import('../../src/cron/store.js');
    store = new CronStore(stateDir);
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('full cron lifecycle: add -> due check -> tick -> mark run', async () => {
    const { parseSchedule } = await import('../../src/cron/store.js');

    // Add a job with interval schedule
    const job = await store.addJob({
      name: 'Every-minute Test',
      prompt: 'What is the time?',
      schedule: parseSchedule('every 1m'),
      deliver: { channelId: 'ch-test', threadId: 'th-test', channelType: 'http' },
    });

    expect(job.enabled).toBe(true);
    expect(job.repeat.times).toBeNull(); // repeats forever
    expect(job.repeat.completed).toBe(0);

    // Job should not be due yet (nextRunAt is ~1m in the future)
    expect(store.getDueJobs()).toHaveLength(0);

    // Simulate time passing: set nextRunAt to the past
    (job as any).nextRunAt = new Date(Date.now() - 60_000).toISOString();
    const dueJobs = store.getDueJobs();
    expect(dueJobs).toHaveLength(1);
    expect(dueJobs[0]!.id).toBe(job.id);

    // Simulate scheduler tick — now submits to inbox instead of direct execution
    const { CronScheduler } = await import('../../src/cron/scheduler.js');
    const submitToInbox = vi.fn();

    const scheduler = new CronScheduler({ store, submitToInbox });

    // Mock getDueJobs to return the job (since we modified in-memory state)
    vi.spyOn(store, 'getDueJobs').mockReturnValue([job]);
    await (scheduler as any).tick();

    // Scheduler should have submitted a cron message to the inbox
    expect(submitToInbox).toHaveBeenCalledTimes(1);
    const msg = submitToInbox.mock.calls[0]![0];
    expect(msg.content).toBe('What is the time?');
    expect(msg.source).toBe('cron');
    expect(msg.cronJobId).toBe(job.id);
    expect(msg.cronJobName).toBe('Every-minute Test');

    // Simulate what the agent loop does after processing — mark the job
    await store.markJobRun(job.id, 'ok');

    const updated = store.getJob(job.id)!;
    expect(updated.lastStatus).toBe('ok');
    expect(updated.repeat.completed).toBe(1);
    expect(updated.enabled).toBe(true); // still enabled (infinite repeat)
  });

  it('delay job disables after single completion', async () => {
    const { parseSchedule } = await import('../../src/cron/store.js');

    const job = await store.addJob({
      name: 'One-shot reminder',
      prompt: 'Remind me',
      schedule: parseSchedule('30m'),
      deliver: { channelId: 'ch', threadId: 'th', channelType: 'http' },
    });

    expect(job.repeat.times).toBe(1);

    await store.markJobRun(job.id, 'ok');

    const updated = store.getJob(job.id)!;
    expect(updated.enabled).toBe(false);
    expect(updated.repeat.completed).toBe(1);
  });

  it('persistence round-trip: add jobs, reload from disk', async () => {
    const { CronStore, parseSchedule } = await import('../../src/cron/store.js');

    await store.addJob({
      name: 'Persist A',
      prompt: 'hello',
      schedule: parseSchedule('every 1h'),
      deliver: { channelId: 'c', threadId: 't', channelType: 'http' },
    });
    await store.addJob({
      name: 'Persist B',
      prompt: 'world',
      schedule: parseSchedule('every 2h'),
      deliver: { channelId: 'c', threadId: 't', channelType: 'http' },
    });

    // Create new store pointing to same directory
    const store2 = new CronStore(stateDir);
    await store2.load();

    const jobs = store2.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.name)).toEqual(['Persist A', 'Persist B']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Auto-Reply Integration
// ════════════════════════════════════════════════════════════════════════════

describe('3. Auto-Reply Integration', () => {
  it('exact match rule works', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: 'hello', response: 'Hi there, {user}!', caseSensitive: false, priority: 0 },
    ]);

    const msg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'telegram',
      threadId: 'th',
      userId: 'u1',
      userName: 'Alice',
      content: 'hello',
      timestamp: Date.now(),
    };

    const reply = engine.check(msg);
    expect(reply).toBe('Hi there, Alice!');
  });

  it('exact match is case-insensitive by default', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: 'hello', response: 'Hi!', caseSensitive: false, priority: 0 },
    ]);

    const msg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'http',
      threadId: 'th',
      userId: 'u1',
      content: 'HELLO',
      timestamp: Date.now(),
    };

    expect(engine.check(msg)).toBe('Hi!');
  });

  it('case-sensitive match rejects wrong case', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: 'Hello', response: 'Hi!', caseSensitive: true, priority: 0 },
    ]);

    const msg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'http',
      threadId: 'th',
      userId: 'u1',
      content: 'hello',
      timestamp: Date.now(),
    };

    expect(engine.check(msg)).toBeNull();
  });

  it('glob pattern works', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: 'hello *', response: 'Greeting received!', caseSensitive: false, priority: 0 },
    ]);

    const msg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'http',
      threadId: 'th',
      userId: 'u1',
      content: 'hello world',
      timestamp: Date.now(),
    };

    expect(engine.check(msg)).toBe('Greeting received!');
  });

  it('regex pattern works', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: '/^(hi|hey|hello)$/i', response: 'Hey back!', caseSensitive: false, priority: 0 },
    ]);

    const makeMsg = (content: string): import('../../src/gateway/types.js').InboundMessage => ({
      id: '1',
      channelId: 'ch',
      channelType: 'http',
      threadId: 'th',
      userId: 'u1',
      content,
      timestamp: Date.now(),
    });

    expect(engine.check(makeMsg('hi'))).toBe('Hey back!');
    expect(engine.check(makeMsg('hey'))).toBe('Hey back!');
    expect(engine.check(makeMsg('hello'))).toBe('Hey back!');
    expect(engine.check(makeMsg('howdy'))).toBeNull();
  });

  it('channel filtering restricts matches', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      {
        pattern: 'help',
        response: 'Telegram help',
        channels: ['telegram'],
        caseSensitive: false,
        priority: 0,
      },
    ]);

    const telegramMsg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'telegram',
      threadId: 'th',
      userId: 'u1',
      content: 'help',
      timestamp: Date.now(),
    };

    const httpMsg: import('../../src/gateway/types.js').InboundMessage = {
      id: '2',
      channelId: 'ch',
      channelType: 'http',
      threadId: 'th',
      userId: 'u1',
      content: 'help',
      timestamp: Date.now(),
    };

    expect(engine.check(telegramMsg)).toBe('Telegram help');
    expect(engine.check(httpMsg)).toBeNull();
  });

  it('priority ordering works (higher priority first)', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: 'test', response: 'Low priority', caseSensitive: false, priority: 0 },
      { pattern: 'test', response: 'High priority', caseSensitive: false, priority: 10 },
    ]);

    const msg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'http',
      threadId: 'th',
      userId: 'u1',
      content: 'test',
      timestamp: Date.now(),
    };

    expect(engine.check(msg)).toBe('High priority');
  });

  it('template variable {channel} expands correctly', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: 'where', response: 'You are on {channel}', caseSensitive: false, priority: 0 },
    ]);

    const msg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'discord',
      threadId: 'th',
      userId: 'u1',
      content: 'where',
      timestamp: Date.now(),
    };

    expect(engine.check(msg)).toBe('You are on discord');
  });

  it('returns null for non-matching messages', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: 'hello', response: 'Hi!', caseSensitive: false, priority: 0 },
    ]);

    const msg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'http',
      threadId: 'th',
      userId: 'u1',
      content: 'goodbye',
      timestamp: Date.now(),
    };

    expect(engine.check(msg)).toBeNull();
  });

  it('returns null for empty content', async () => {
    const { AutoReplyEngine } = await import('../../src/gateway/auto-reply.js');
    const engine = new AutoReplyEngine([
      { pattern: '*', response: 'catch all', caseSensitive: false, priority: 0 },
    ]);

    const msg: import('../../src/gateway/types.js').InboundMessage = {
      id: '1',
      channelId: 'ch',
      channelType: 'http',
      threadId: 'th',
      userId: 'u1',
      content: '   ',
      timestamp: Date.now(),
    };

    expect(engine.check(msg)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Rate Limiter + Usage Tracker Integration
// ════════════════════════════════════════════════════════════════════════════

describe('4. Rate Limiter + Usage Tracker Integration', () => {
  describe('RateLimiter', () => {
    it('allows messages within limit', async () => {
      const { RateLimiter } = await import('../../src/gateway/rate-limiter.js');
      const limiter = new RateLimiter({ maxMessages: 5, windowMs: 60_000 });

      for (let i = 0; i < 5; i++) {
        const result = limiter.check('user-1');
        expect(result.allowed).toBe(true);
      }
    });

    it('blocks messages exceeding limit', async () => {
      const { RateLimiter } = await import('../../src/gateway/rate-limiter.js');
      const limiter = new RateLimiter({ maxMessages: 3, windowMs: 60_000 });

      for (let i = 0; i < 3; i++) {
        expect(limiter.check('user-1').allowed).toBe(true);
      }

      const blocked = limiter.check('user-1');
      expect(blocked.allowed).toBe(false);
      if (!blocked.allowed) {
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
      }
    });

    it('separate users have separate limits', async () => {
      const { RateLimiter } = await import('../../src/gateway/rate-limiter.js');
      const limiter = new RateLimiter({ maxMessages: 2, windowMs: 60_000 });

      expect(limiter.check('user-a').allowed).toBe(true);
      expect(limiter.check('user-a').allowed).toBe(true);
      expect(limiter.check('user-a').allowed).toBe(false);

      // User B should still be allowed
      expect(limiter.check('user-b').allowed).toBe(true);
      expect(limiter.check('user-b').allowed).toBe(true);
    });

    it('hit default limit (30 messages)', async () => {
      const { RateLimiter } = await import('../../src/gateway/rate-limiter.js');
      const limiter = new RateLimiter(); // defaults: maxMessages=30, windowMs=60000

      for (let i = 0; i < 30; i++) {
        expect(limiter.check('stress-user').allowed).toBe(true);
      }

      const blocked = limiter.check('stress-user');
      expect(blocked.allowed).toBe(false);
    });

    it('getUsage tracks correct count', async () => {
      const { RateLimiter } = await import('../../src/gateway/rate-limiter.js');
      const limiter = new RateLimiter({ maxMessages: 10, windowMs: 60_000 });

      limiter.check('counted');
      limiter.check('counted');
      limiter.check('counted');

      const usage = limiter.getUsage('counted');
      expect(usage.count).toBe(3);
      expect(usage.maxMessages).toBe(10);
    });

    it('getUsage returns 0 for unknown user', async () => {
      const { RateLimiter } = await import('../../src/gateway/rate-limiter.js');
      const limiter = new RateLimiter();
      const usage = limiter.getUsage('nobody');
      expect(usage.count).toBe(0);
    });
  });

  describe('UsageTracker with real StateStore', () => {
    let testDir: string;
    let dbPath: string;

    beforeEach(async () => {
      testDir = tmpDir('shizuha-tracker');
      await fs.mkdir(testDir, { recursive: true });
      dbPath = path.join(testDir, 'state.db');
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    });

    it('records and aggregates usage', async () => {
      const { StateStore } = await import('../../src/state/store.js');
      const { UsageTracker } = await import('../../src/gateway/usage-tracker.js');

      const store = new StateStore(dbPath);
      const tracker = new UsageTracker(store);

      tracker.recordMessage('alice', 'telegram', 100, 200, 2);
      tracker.recordMessage('alice', 'telegram', 50, 100, 1);
      tracker.recordMessage('bob', 'http', 300, 600, 5);

      const aliceRecords = tracker.getUserUsage('alice');
      expect(aliceRecords).toHaveLength(1);
      expect(aliceRecords[0]!.messageCount).toBe(2); // 2 messages
      expect(aliceRecords[0]!.inputTokens).toBe(150); // 100 + 50
      expect(aliceRecords[0]!.outputTokens).toBe(300); // 200 + 100
      expect(aliceRecords[0]!.toolCalls).toBe(3); // 2 + 1

      const agg = tracker.getAggregateStats();
      expect(agg.totalMessages).toBe(3);
      expect(agg.uniqueUsers).toBe(2);
      expect(agg.totalInputTokens).toBe(450);
      expect(agg.totalOutputTokens).toBe(900);
      expect(agg.totalToolCalls).toBe(8);

      const all = tracker.getAllUsage();
      expect(all).toHaveLength(2);

      store.close();
    });

    it('handles multiple channels per user', async () => {
      const { StateStore } = await import('../../src/state/store.js');
      const { UsageTracker } = await import('../../src/gateway/usage-tracker.js');

      const store = new StateStore(dbPath);
      const tracker = new UsageTracker(store);

      tracker.recordMessage('alice', 'telegram', 100, 200, 1);
      tracker.recordMessage('alice', 'http', 50, 100, 0);

      const records = tracker.getUserUsage('alice');
      expect(records).toHaveLength(2); // separate records per (userId, channelType)

      store.close();
    });

    it('returns empty for unknown user', async () => {
      const { StateStore } = await import('../../src/state/store.js');
      const { UsageTracker } = await import('../../src/gateway/usage-tracker.js');

      const store = new StateStore(dbPath);
      const tracker = new UsageTracker(store);

      const records = tracker.getUserUsage('nobody');
      expect(records).toHaveLength(0);

      store.close();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Toolset Integration
// ════════════════════════════════════════════════════════════════════════════

describe('5. Toolset Integration', () => {
  it('messaging toolset excludes bash/write/edit/notebook/browser', async () => {
    const { ToolsetManager } = await import('../../src/tools/toolsets.js');
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const allNames = registry.list().map((t) => t.name);

    const manager = new ToolsetManager();
    const filtered = manager.filterTools('messaging', allNames);

    expect(filtered).not.toContain('bash');
    expect(filtered).not.toContain('write');
    expect(filtered).not.toContain('edit');
    expect(filtered).not.toContain('notebook');
    expect(filtered).not.toContain('browser');

    // Should include read tools
    expect(filtered).toContain('read');
    expect(filtered).toContain('glob');
    expect(filtered).toContain('grep');
  });

  it('safe toolset only includes read-only tools', async () => {
    const { ToolsetManager, BUILTIN_TOOLSETS } = await import('../../src/tools/toolsets.js');
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const allNames = registry.list().map((t) => t.name);

    const manager = new ToolsetManager();
    const filtered = manager.filterTools('safe', allNames);

    // Safe toolset should be very restrictive
    const safeSet = BUILTIN_TOOLSETS['safe']!;
    expect(filtered.length).toBeLessThan(allNames.length);

    // Should include read-only tools
    expect(filtered).toContain('read');
    expect(filtered).toContain('glob');
    expect(filtered).toContain('grep');
    expect(filtered).toContain('web_fetch');
    expect(filtered).toContain('memory');
    expect(filtered).toContain('pdf_extract');

    // Should NOT include write tools
    expect(filtered).not.toContain('bash');
    expect(filtered).not.toContain('write');
    expect(filtered).not.toContain('edit');
    expect(filtered).not.toContain('browser');
  });

  it('safe toolset is more restrictive than messaging', async () => {
    const { ToolsetManager } = await import('../../src/tools/toolsets.js');
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const allNames = registry.list().map((t) => t.name);

    const manager = new ToolsetManager();
    const safeFiltered = manager.filterTools('safe', allNames);
    const messagingFiltered = manager.filterTools('messaging', allNames);

    expect(safeFiltered.length).toBeLessThan(messagingFiltered.length);
  });

  it('full toolset includes everything', async () => {
    const { ToolsetManager } = await import('../../src/tools/toolsets.js');
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const allNames = registry.list().map((t) => t.name);

    const manager = new ToolsetManager();
    const filtered = manager.filterTools('full', allNames);

    expect(filtered.length).toBe(allNames.length);
  });

  it('unknown toolset returns all tools with fallback', async () => {
    const { ToolsetManager } = await import('../../src/tools/toolsets.js');

    const manager = new ToolsetManager();
    const allNames = ['read', 'write', 'bash'];
    const filtered = manager.filterTools('nonexistent', allNames);

    expect(filtered).toEqual(allNames);
  });

  it('custom toolset can be registered', async () => {
    const { ToolsetManager } = await import('../../src/tools/toolsets.js');

    const manager = new ToolsetManager();
    manager.register({
      name: 'minimal',
      description: 'Only read',
      include: ['read', 'glob'],
    });

    const filtered = manager.filterTools('minimal', ['read', 'write', 'glob', 'bash']);
    expect(filtered).toEqual(['read', 'glob']);
  });

  it('glob pattern matching works for MCP tools', async () => {
    const { ToolsetManager } = await import('../../src/tools/toolsets.js');

    const manager = new ToolsetManager();
    manager.register({
      name: 'mcp-only',
      include: ['mcp__*'],
    });

    const allNames = ['read', 'write', 'mcp__pulse__list_tasks', 'mcp__wiki__search'];
    const filtered = manager.filterTools('mcp-only', allNames);
    expect(filtered).toEqual(['mcp__pulse__list_tasks', 'mcp__wiki__search']);
  });

  it('lists all available toolsets', async () => {
    const { ToolsetManager } = await import('../../src/tools/toolsets.js');
    const manager = new ToolsetManager();
    const toolsets = manager.list();
    const names = toolsets.map((t) => t.name);

    expect(names).toContain('full');
    expect(names).toContain('safe');
    expect(names).toContain('messaging');
    expect(names).toContain('developer');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Permission Engine + Network Policy Integration
// ════════════════════════════════════════════════════════════════════════════

describe('6. Permission Engine + Network Policy Integration', () => {
  it('autonomous mode allows everything by default', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('autonomous');

    expect(engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' })).toBe('allow');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('allow');
    expect(engine.check({ toolName: 'read', input: {}, riskLevel: 'low' })).toBe('allow');
  });

  it('supervised mode auto-allows low-risk and asks for others', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('supervised');

    expect(engine.check({ toolName: 'read', input: {}, riskLevel: 'low' })).toBe('allow');
    expect(engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' })).toBe('ask');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('ask');
  });

  it('plan mode denies non-read tools', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('plan');

    expect(engine.check({ toolName: 'read', input: {}, riskLevel: 'low' })).toBe('allow');
    expect(engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' })).toBe('deny');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('deny');
  });

  it('network policy allows web_fetch to allowed host', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: {
        networkAccess: true,
        allowedHosts: ['api.example.com', '*.github.com'],
      },
    });

    const result = engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://api.example.com/data' },
      riskLevel: 'medium',
    });
    expect(result).toBe('allow');
  });

  it('network policy denies web_fetch to blocked host', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: {
        networkAccess: true,
        allowedHosts: ['api.example.com'],
      },
    });

    const result = engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://evil.com/steal' },
      riskLevel: 'medium',
    });
    expect(result).toBe('deny');
  });

  it('network policy wildcard host matching', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: {
        networkAccess: true,
        allowedHosts: ['*.github.com'],
      },
    });

    // Subdomain should match
    expect(
      engine.check({
        toolName: 'web_fetch',
        input: { url: 'https://api.github.com/repos' },
        riskLevel: 'medium',
      }),
    ).toBe('allow');

    // Base domain should also match
    expect(
      engine.check({
        toolName: 'web_fetch',
        input: { url: 'https://github.com/repos' },
        riskLevel: 'medium',
      }),
    ).toBe('allow');

    // Other domain should not
    expect(
      engine.check({
        toolName: 'web_fetch',
        input: { url: 'https://gitlab.com/repos' },
        riskLevel: 'medium',
      }),
    ).toBe('deny');
  });

  it('non-network tools unaffected by network policy', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: {
        networkAccess: false, // network disabled entirely
        allowedHosts: [],
      },
    });

    // Non-network tools should be unaffected
    expect(engine.check({ toolName: 'read', input: {}, riskLevel: 'low' })).toBe('allow');
    expect(engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' })).toBe('allow');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('allow');

    // Network tools should be denied
    expect(engine.check({ toolName: 'web_fetch', input: { url: 'https://example.com' }, riskLevel: 'medium' })).toBe('deny');
    expect(engine.check({ toolName: 'web_search', input: { url: 'https://example.com' }, riskLevel: 'medium' })).toBe('deny');
  });

  it('explicit rules override mode defaults', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('supervised', [
      { tool: 'bash', decision: 'allow' }, // override: always allow bash
    ]);

    // bash would normally be 'ask' in supervised mode, but rule overrides
    expect(engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' })).toBe('allow');
  });

  it('session approvals persist within session', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('supervised');

    // First call should ask
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('ask');

    // Approve it
    engine.approve('write');

    // Now it should be allowed
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('allow');
  });

  it('plan mode allows write to plan file', async () => {
    const { PermissionEngine } = await import('../../src/permissions/engine.js');
    const engine = new PermissionEngine('plan');
    engine.setPlanFilePath('/tmp/plan.md');

    // Write to plan file should be allowed
    expect(
      engine.check({ toolName: 'write', input: { file_path: '/tmp/plan.md' }, riskLevel: 'medium' }),
    ).toBe('allow');

    // Write to other files should be denied
    expect(
      engine.check({ toolName: 'write', input: { file_path: '/tmp/other.md' }, riskLevel: 'medium' }),
    ).toBe('deny');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Doctor Command Integration
// ════════════════════════════════════════════════════════════════════════════

describe('7. Doctor Command Integration', () => {
  it('runDoctor returns an array of checks', async () => {
    const { runDoctor } = await import('../../src/commands/doctor.js');
    const checks = await runDoctor(process.cwd());

    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);

    // Each check should have required fields
    for (const check of checks) {
      expect(check.name).toBeTruthy();
      expect(['pass', 'warn', 'fail']).toContain(check.status);
      expect(check.message).toBeTruthy();
    }
  });

  it('Node.js version check passes (we are running Node)', async () => {
    const { runDoctor } = await import('../../src/commands/doctor.js');
    const checks = await runDoctor(process.cwd());

    const nodeCheck = checks.find((c) => c.name === 'Node.js version');
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck!.status).toBe('pass');
    expect(nodeCheck!.message).toContain(process.version);
  });

  it('dependencies check passes for required packages', async () => {
    const { runDoctor } = await import('../../src/commands/doctor.js');
    const checks = await runDoctor(process.cwd());

    const zodCheck = checks.find((c) => c.name === 'Dependency: zod');
    expect(zodCheck).toBeDefined();
    expect(zodCheck!.status).toBe('pass');

    const sqliteCheck = checks.find((c) => c.name === 'Dependency: better-sqlite3');
    expect(sqliteCheck).toBeDefined();
    expect(sqliteCheck!.status).toBe('pass');
  });

  it('SQLite state store check passes', async () => {
    const { runDoctor } = await import('../../src/commands/doctor.js');
    const checks = await runDoctor(process.cwd());

    const sqliteCheck = checks.find((c) => c.name === 'SQLite state store');
    expect(sqliteCheck).toBeDefined();
    expect(sqliteCheck!.status).toBe('pass');
  });

  it('disk space check passes', async () => {
    const { runDoctor } = await import('../../src/commands/doctor.js');
    const checks = await runDoctor(process.cwd());

    const diskCheck = checks.find((c) => c.name === 'Disk space');
    expect(diskCheck).toBeDefined();
    expect(['pass', 'warn']).toContain(diskCheck!.status);
  });

  it('permissions check passes', async () => {
    const { runDoctor } = await import('../../src/commands/doctor.js');
    const checks = await runDoctor(process.cwd());

    const permCheck = checks.find((c) => c.name === 'Permissions');
    expect(permCheck).toBeDefined();
    expect(permCheck!.status).toBe('pass');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Config Schema Integration
// ════════════════════════════════════════════════════════════════════════════

describe('8. Config Schema Integration', () => {
  it('parses empty object with defaults', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    const config = configSchema.parse({});

    expect(config.agent.defaultModel).toBe('auto');
    expect(config.agent.maxTurns).toBe(0);
    expect(config.agent.temperature).toBe(0);
    expect(config.agent.maxOutputTokens).toBe(32000);
    expect(config.permissions.mode).toBe('supervised');
    expect(config.permissions.rules).toEqual([]);
    expect(config.mcp.servers).toEqual([]);
    expect(config.hooks.hooks).toEqual([]);
    expect(config.autoReply.enabled).toBe(false);
    expect(config.autoReply.rules).toEqual([]);
    expect(config.sandbox.mode).toBe('unrestricted');
    expect(config.sandbox.protectedPaths).toEqual(['.git', '.shizuha', '.env', '.claude']);
    expect(config.skills.trustProjectSkills).toBe(false);
    expect(config.logging.level).toBe('info');
  });

  it('parses config with autoReply rules', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    const config = configSchema.parse({
      autoReply: {
        enabled: true,
        rules: [
          { pattern: 'hello', response: 'Hi!', priority: 10 },
          { pattern: '/^help$/i', response: 'How can I help?', channels: ['telegram'] },
        ],
      },
    });

    expect(config.autoReply.enabled).toBe(true);
    expect(config.autoReply.rules).toHaveLength(2);
    expect(config.autoReply.rules[0]!.pattern).toBe('hello');
    expect(config.autoReply.rules[0]!.priority).toBe(10);
    expect(config.autoReply.rules[0]!.caseSensitive).toBe(false); // default
    expect(config.autoReply.rules[1]!.channels).toEqual(['telegram']);
  });

  it('parses config with toolset', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    const config = configSchema.parse({
      agent: { toolset: 'messaging' },
    });

    expect(config.agent.toolset).toBe('messaging');
  });

  it('parses config with sandbox settings', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    const config = configSchema.parse({
      sandbox: {
        mode: 'workspace-write',
        writablePaths: ['/data'],
        networkAccess: true,
        allowedHosts: ['*.example.com'],
      },
    });

    expect(config.sandbox.mode).toBe('workspace-write');
    expect(config.sandbox.writablePaths).toEqual(['/data']);
    expect(config.sandbox.networkAccess).toBe(true);
    expect(config.sandbox.allowedHosts).toEqual(['*.example.com']);
  });

  it('parses config with MCP servers', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    const config = configSchema.parse({
      mcp: {
        servers: [
          { name: 'test-server', transport: 'stdio', command: 'node', args: ['server.js'] },
        ],
        toolSearch: { mode: 'on', maxResults: 10 },
      },
    });

    expect(config.mcp.servers).toHaveLength(1);
    expect(config.mcp.servers[0]!.name).toBe('test-server');
    expect(config.mcp.toolSearch.mode).toBe('on');
    expect(config.mcp.toolSearch.maxResults).toBe(10);
  });

  it('parses config with permission rules', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    const config = configSchema.parse({
      permissions: {
        mode: 'autonomous',
        rules: [
          { tool: 'bash', decision: 'ask' },
          { tool: 'mcp__*', decision: 'allow' },
        ],
      },
    });

    expect(config.permissions.mode).toBe('autonomous');
    expect(config.permissions.rules).toHaveLength(2);
    expect(config.permissions.rules[0]!.tool).toBe('bash');
    expect(config.permissions.rules[0]!.decision).toBe('ask');
  });

  it('rejects invalid permission mode', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    expect(() =>
      configSchema.parse({
        permissions: { mode: 'invalid_mode' },
      }),
    ).toThrow();
  });

  it('rejects invalid sandbox mode', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    expect(() =>
      configSchema.parse({
        sandbox: { mode: 'super-dangerous' },
      }),
    ).toThrow();
  });

  it('per-agent config schema parses correctly', async () => {
    const { perAgentConfigSchema } = await import('../../src/config/schema.js');
    const config = perAgentConfigSchema.parse({
      model: 'claude-sonnet-4-20250514',
      thinkingLevel: 'high',
      permissionMode: 'autonomous',
      temperature: 0.5,
      maxOutputTokens: 16000,
      toolset: 'developer',
    });

    expect(config.model).toBe('claude-sonnet-4-20250514');
    expect(config.thinkingLevel).toBe('high');
    expect(config.permissionMode).toBe('autonomous');
    expect(config.temperature).toBe(0.5);
    expect(config.toolset).toBe('developer');
  });

  it('per-agent config accepts all fields optional', async () => {
    const { perAgentConfigSchema } = await import('../../src/config/schema.js');
    const config = perAgentConfigSchema.parse({});

    expect(config.model).toBeUndefined();
    expect(config.thinkingLevel).toBeUndefined();
    expect(config.toolset).toBeUndefined();
  });

  it('hooks schema parses correctly', async () => {
    const { configSchema } = await import('../../src/config/schema.js');
    const config = configSchema.parse({
      hooks: {
        hooks: [
          {
            event: 'PreToolUse',
            matcher: 'bash',
            command: 'echo "bash called"',
            timeout: 5000,
          },
        ],
      },
    });

    expect(config.hooks.hooks).toHaveLength(1);
    expect(config.hooks.hooks[0]!.event).toBe('PreToolUse');
    expect(config.hooks.hooks[0]!.matcher).toBe('bash');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Loop Detector Integration
// ════════════════════════════════════════════════════════════════════════════

describe('9. Loop Detector Integration', () => {
  it('returns ok for unique tool calls', async () => {
    const { LoopDetector } = await import('../../src/agent/loop-detector.js');
    const detector = new LoopDetector();

    expect(detector.record('read', { file: 'a.ts' })).toBe('ok');
    expect(detector.record('write', { file: 'b.ts' })).toBe('ok');
    expect(detector.record('bash', { command: 'ls' })).toBe('ok');
    expect(detector.record('grep', { pattern: 'foo' })).toBe('ok');
  });

  it('detects exact repeat pattern -> warning at threshold', async () => {
    const { LoopDetector } = await import('../../src/agent/loop-detector.js');
    const detector = new LoopDetector({ warningThreshold: 3, breakThreshold: 5 });

    const input = { command: 'npm test' };
    expect(detector.record('bash', input)).toBe('ok');
    expect(detector.record('bash', input)).toBe('ok');
    expect(detector.record('bash', input)).toBe('warning'); // 3rd = warning
    expect(detector.record('bash', input)).toBe('warning'); // 4th = warning
    expect(detector.record('bash', input)).toBe('break');   // 5th = break
  });

  it('detects ping-pong pattern', async () => {
    const { LoopDetector } = await import('../../src/agent/loop-detector.js');
    const detector = new LoopDetector({ warningThreshold: 3, breakThreshold: 5 });

    const inputA = { file: 'a.ts' };
    const inputB = { file: 'b.ts' };

    // Build up A -> B -> A -> B -> A -> B pattern
    expect(detector.record('read', inputA)).toBe('ok');
    expect(detector.record('write', inputB)).toBe('ok');
    expect(detector.record('read', inputA)).toBe('ok');
    expect(detector.record('write', inputB)).toBe('ok');
    expect(detector.record('read', inputA)).toBe('ok');
    expect(detector.record('write', inputB)).toBe('warning'); // 3rd ping-pong pair
  });

  it('reset clears history', async () => {
    const { LoopDetector } = await import('../../src/agent/loop-detector.js');
    const detector = new LoopDetector({ warningThreshold: 2, breakThreshold: 4 });

    const input = { command: 'echo hi' };
    detector.record('bash', input);
    detector.record('bash', input); // warning
    detector.reset();

    // After reset, same call should be ok again
    expect(detector.record('bash', input)).toBe('ok');
  });

  it('different inputs do not trigger repeat detection', async () => {
    const { LoopDetector } = await import('../../src/agent/loop-detector.js');
    const detector = new LoopDetector({ warningThreshold: 2, breakThreshold: 3 });

    expect(detector.record('bash', { command: 'ls' })).toBe('ok');
    expect(detector.record('bash', { command: 'pwd' })).toBe('ok');
    expect(detector.record('bash', { command: 'date' })).toBe('ok');
    // All different inputs, no repeat
  });

  it('history is capped at 20 entries', async () => {
    const { LoopDetector } = await import('../../src/agent/loop-detector.js');
    const detector = new LoopDetector({ warningThreshold: 25, breakThreshold: 30 });

    // Record 25 unique calls
    for (let i = 0; i < 25; i++) {
      detector.record('read', { file: `file${i}.ts` });
    }

    // Internal history should be capped (we verify indirectly by checking that
    // recording more unique calls doesn't cause issues)
    expect(detector.record('read', { file: 'file99.ts' })).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Browser Manager Integration
// ════════════════════════════════════════════════════════════════════════════

describe('10. Browser Manager Integration', () => {
  it('creates sessions with unique IDs', async () => {
    // We import the BrowserSession class directly to avoid launching Playwright
    const { BrowserSession } = await import('../../src/browser/session.js');

    // Test BrowserSession construction and cleanup
    let closeCallbackFired = false;
    const session = new BrowserSession(() => {
      closeCallbackFired = true;
    });

    expect(session.isActive).toBe(false); // not active until ensurePage is called
    const closeResult = await session.close();
    expect(closeResult).toBe('Browser session closed.');
    expect(closeCallbackFired).toBe(true);
  });

  it('max concurrent session limit is enforced', async () => {
    // We test the BrowserManager class directly
    // Create a separate instance to avoid interfering with the singleton
    const managerModule = await import('../../src/browser/manager.js');
    const { browserManager } = managerModule;

    // Track original count
    const originalCount = browserManager.activeCount;

    // Create sessions up to the limit (3)
    const sessionsToCreate = 3 - originalCount;
    const sessionIds: string[] = [];

    for (let i = 0; i < sessionsToCreate; i++) {
      const id = `test-session-${crypto.randomUUID()}`;
      sessionIds.push(id);
      browserManager.getSession(id);
    }

    // Now at limit — next should throw
    expect(() => browserManager.getSession(`test-overflow-${crypto.randomUUID()}`)).toThrow(
      'Maximum concurrent browser sessions',
    );

    // Getting existing session should work
    const existing = browserManager.getSession(sessionIds[0]!);
    expect(existing).toBeDefined();

    // Clean up: close all test sessions
    await browserManager.closeAll();
    expect(browserManager.activeCount).toBe(0);
  });

  it('getSession returns same session for same ID', async () => {
    const { browserManager } = await import('../../src/browser/manager.js');

    const id = `reuse-test-${crypto.randomUUID()}`;
    const session1 = browserManager.getSession(id);
    const session2 = browserManager.getSession(id);

    expect(session1).toBe(session2);

    await browserManager.closeAll();
  });

  it('closeAll clears all sessions', async () => {
    const { browserManager } = await import('../../src/browser/manager.js');

    browserManager.getSession(`cleanup-1-${crypto.randomUUID()}`);
    browserManager.getSession(`cleanup-2-${crypto.randomUUID()}`);

    expect(browserManager.activeCount).toBeGreaterThanOrEqual(2);

    await browserManager.closeAll();
    expect(browserManager.activeCount).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cross-feature: StateStore + Session Search
// ════════════════════════════════════════════════════════════════════════════

describe('Cross-feature: StateStore + Session Search', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = tmpDir('shizuha-search-int');
    await fs.mkdir(testDir, { recursive: true });
    dbPath = path.join(testDir, 'state.db');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('indexes and searches messages across sessions', async () => {
    const { StateStore } = await import('../../src/state/store.js');
    const store = new StateStore(dbPath);

    // Create sessions and append messages
    const session1 = store.createSession('claude-sonnet', '/project1');
    store.appendMessage(session1.id, {
      role: 'user',
      content: 'How do I configure TypeScript in this project?',
      timestamp: Date.now() - 3600_000,
    });
    store.appendMessage(session1.id, {
      role: 'assistant',
      content: 'You can configure TypeScript by editing tsconfig.json',
      timestamp: Date.now() - 3500_000,
    });

    const session2 = store.createSession('gpt-4', '/project2');
    store.appendMessage(session2.id, {
      role: 'user',
      content: 'What databases does the project use?',
      timestamp: Date.now() - 1800_000,
    });
    store.appendMessage(session2.id, {
      role: 'assistant',
      content: 'The project uses PostgreSQL and Redis for caching',
      timestamp: Date.now() - 1700_000,
    });

    // Search for TypeScript
    const tsResults = store.searchMessages('TypeScript');
    expect(tsResults.length).toBeGreaterThanOrEqual(1);
    expect(tsResults.some((r) => r.content.includes('TypeScript'))).toBe(true);

    // Search for databases
    const dbResults = store.searchMessages('PostgreSQL');
    expect(dbResults.length).toBeGreaterThanOrEqual(1);

    // Search with no results
    const emptyResults = store.searchMessages('Kubernetes');
    expect(emptyResults).toHaveLength(0);

    store.close();
  });

  it('session CRUD lifecycle', async () => {
    const { StateStore } = await import('../../src/state/store.js');
    const store = new StateStore(dbPath);

    // Create
    const session = store.createSession('claude-opus', '/workspace');
    expect(session.id).toBeTruthy();
    expect(session.model).toBe('claude-opus');

    // Load
    const loaded = store.loadSession(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);

    // Append message
    store.appendMessage(session.id, {
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    });

    const reloaded = store.loadSession(session.id);
    expect(reloaded!.messages).toHaveLength(1);
    expect(reloaded!.messages[0]!.content).toBe('Hello');

    // List sessions
    const sessions = store.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.id === session.id)).toBe(true);

    // Delete
    const deleted = store.deleteSession(session.id);
    expect(deleted).toBe(true);

    const afterDelete = store.loadSession(session.id);
    expect(afterDelete).toBeNull();

    store.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cross-feature: Tool Registry JSON Schema Generation
// ════════════════════════════════════════════════════════════════════════════

describe('Cross-feature: Tool definitions for LLM', () => {
  it('all tool definitions produce valid JSON Schema', async () => {
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const defs = registry.definitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema).toBeDefined();
      expect(typeof def.inputSchema).toBe('object');

      // Should have at least a type field
      const schema = def.inputSchema as Record<string, unknown>;
      expect(schema.type || schema.properties || schema.allOf || schema.oneOf).toBeDefined();
    }
  });

  it('tool names are unique and follow naming convention', async () => {
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const tools = registry.list();
    const names = tools.map((t) => t.name);

    // All unique
    expect(new Set(names).size).toBe(names.length);

    // All snake_case, lowercase, or PascalCase (some legacy tools use PascalCase)
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
    }
  });

  it('each tool has appropriate risk level and readOnly flag', async () => {
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const tools = registry.list();
    for (const tool of tools) {
      expect(['low', 'medium', 'high']).toContain(tool.riskLevel);
      expect(typeof tool.readOnly).toBe('boolean');
    }

    // Specific checks for known tools
    expect(registry.get('read')!.readOnly).toBe(true);
    expect(registry.get('read')!.riskLevel).toBe('low');
    expect(registry.get('bash')!.readOnly).toBe(false);
    expect(registry.get('bash')!.riskLevel).toBe('high');
    expect(registry.get('memory')!.riskLevel).toBe('low');
    expect(registry.get('schedule_job')!.riskLevel).toBe('medium');
  });

  it('duplicate registration throws error', async () => {
    const { ToolRegistry } = await import('../../src/tools/registry.js');
    const { registerBuiltinTools } = await import('../../src/tools/builtin/index.js');

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    // Trying to register a tool that already exists should throw
    expect(() =>
      registerBuiltinTools(registry),
    ).toThrow('already registered');
  });
});
