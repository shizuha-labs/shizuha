/**
 * SCLI-618 — Stop-hook background awareness.
 *
 * The SessionStop lifecycle hook must receive BACKGROUND_TASKS (JSON array of
 * non-terminal background tasks) and ACTIVE_CRONS (JSON array of enabled cron
 * jobs) so hooks can react to still-running background work on shutdown —
 * mirroring Grok Build's Stop-hook backgroundTasks[]/sessionCrons[] payload.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import { CronStore } from '../../src/cron/store.js';
import { CronScheduler } from '../../src/cron/scheduler.js';
import type { InboundMessage } from '../../src/gateway/types.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type StopHookHarness = AgentProcess & {
  hookEngine: {
    hasHooks: ReturnType<typeof vi.fn>;
    runHooks: ReturnType<typeof vi.fn>;
  };
  cronScheduler: CronScheduler | null;
};

let capturedEnv: Record<string, string> | null = null;

function makeHarness(): StopHookHarness {
  const agent = new AgentProcess({ channels: [], cwd: '/tmp', permissionMode: 'autonomous' }) as unknown as StopHookHarness;
  capturedEnv = null;
  agent.hookEngine = {
    hasHooks: vi.fn((event: string) => event === 'SessionStop'),
    runHooks: vi.fn(async (_event: string, env: Record<string, string>) => {
      capturedEnv = env;
      return [];
    }),
  };
  return agent;
}

async function makeCronScheduler(): Promise<CronScheduler> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli618-cron-'));
  const store = new CronStore(stateDir);
  await store.load();
  await store.addJob({
    name: 'Morning Summary',
    prompt: 'Summarize my unread emails',
    schedule: { kind: 'interval', ms: 60_000, display: 'every 1m' },
    deliver: { channelId: 'connect', threadId: 't', channelType: 'connect' },
  });
  const scheduler = new CronScheduler({ store, submitToInbox: (_msg: InboundMessage) => {} });
  return scheduler;
}

afterEach(() => {
  vi.restoreAllMocks();
  capturedEnv = null;
});

describe('SCLI-618 SessionStop hook background awareness', () => {
  it('passes BACKGROUND_TASKS + ACTIVE_CRONS populated with live state', async () => {
    const agent = makeHarness();
    // Running + pending background tasks must be included…
    const running = agent.taskRegistry.create('bash', 'run tests');
    const pending = agent.taskRegistry.create('agent', 'review PR');
    // …terminal tasks must be excluded.
    const done = agent.taskRegistry.create('bash', 'already finished');
    agent.taskRegistry.complete(done.id, 0);

    agent.cronScheduler = await makeCronScheduler();

    await agent.stop();

    expect(capturedEnv).not.toBeNull();
    expect(agent.hookEngine.hasHooks).toHaveBeenCalledWith('SessionStop');
    expect(agent.hookEngine.runHooks).toHaveBeenCalledOnce();

    const backgroundTasks = JSON.parse(capturedEnv!['BACKGROUND_TASKS']!) as Array<{
      id: string; type: string; status: string; description: string;
    }>;
    expect(backgroundTasks).toHaveLength(2);
    expect(backgroundTasks.map((t) => t.id).sort()).toEqual([running.id, pending.id].sort());
    expect(backgroundTasks).toContainEqual({ id: running.id, type: 'bash', status: 'running', description: 'run tests' });
    expect(backgroundTasks).toContainEqual({ id: pending.id, type: 'agent', status: 'running', description: 'review PR' });
    expect(backgroundTasks.some((t) => t.id === done.id)).toBe(false);

    const activeCrons = JSON.parse(capturedEnv!['ACTIVE_CRONS']!) as Array<{
      id: string; name: string; schedule: string;
    }>;
    expect(activeCrons).toHaveLength(1);
    expect(activeCrons[0]).toMatchObject({ name: 'Morning Summary', schedule: 'every 1m' });
    expect(activeCrons[0]!.id).toBeTruthy();
  });

  it('passes empty arrays when no tasks or crons are active', async () => {
    const agent = makeHarness();
    agent.cronScheduler = null;

    await agent.stop();

    expect(capturedEnv).not.toBeNull();
    expect(JSON.parse(capturedEnv!['BACKGROUND_TASKS']!)).toEqual([]);
    expect(JSON.parse(capturedEnv!['ACTIVE_CRONS']!)).toEqual([]);
  });

  it('does not fire SessionStop when no hooks are registered', async () => {
    const agent = makeHarness();
    agent.hookEngine.hasHooks.mockReturnValue(false);

    await agent.stop();

    expect(agent.hookEngine.runHooks).not.toHaveBeenCalled();
    expect(capturedEnv).toBeNull();
  });
});
