import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
  }));
  children.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function worker(directory: string, cycle: number, epoch: boolean | 'heartbeat' = false): Promise<any> {
  const script = fileURLToPath(new URL('../helpers/tool-attempt-crash-worker.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script, directory, String(cycle), epoch === 'heartbeat' ? 'heartbeat' : epoch ? 'epoch' : 'zero'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, SHIZUHA_LOG_LEVEL: 'silent', SHIZUHA_PREWARM_ENABLE: '0' },
  });
  children.add(child);
  let output = '';
  child.stdout!.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  child.stderr!.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => { children.delete(child); resolve(); }));
  const receipt = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker did not reach boundary: ${output}`)), 10000);
    child.once('message', (message) => { clearTimeout(timeout); resolve(message); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Worker exited before boundary: ${output}`)); });
  });
  if (cycle <= 2 || receipt.event === 'committed') child.kill('SIGKILL');
  await exited;
  return receipt;
}

describe('real gateway crash-before-tool-checkpoint recovery', () => {
  it.each([false, true])('preserves completed partial batches and unknown attempts through two killed process generations (persisted epoch=%s)', async (epoch) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gateway-tool-crash-'));
    directories.push(directory);
    const first = await worker(directory, 1, epoch);
    expect(first.event).toBe('pending');
    expect(first.calls).toEqual(['done-1', 'pending-1']);
    expect(first.attempts).toEqual([
      expect.objectContaining({ tool_call_id: 'done-1', state: 'completed', result_json: expect.stringContaining('actual receipt done-1') }),
      expect.objectContaining({ tool_call_id: 'pending-1', state: 'running', input_json: '{"step":"pending-1"}' }),
    ]);
    expect(first.inboundCompleted).toBe(false);
    expect(first.sessionEpoch).toBe(epoch ? 1 : 0);
    expect(first.auditEvents).toEqual([
      { phase: 'before', calls: [] },
      { phase: 'after', calls: ['done-1'], durationMs: expect.any(Number) },
      { phase: 'before', calls: ['done-1'] },
    ]);
    expect(first.auditEvents[1].durationMs).toBeGreaterThanOrEqual(20);
    const second = await worker(directory, 2, epoch);
    expect(second.sessionEpoch).toBe(epoch ? 1 : 0);
    expect(second.calls).toEqual(['done-2', 'pending-2']);
    expect(second.providerCalls).toBe(1);
    expect(JSON.stringify(second.request)).toContain('actual receipt done-1');
    expect(JSON.stringify(second.request)).toContain('Outcome is unknown; side effects may have occurred');
    expect(second.attempts.find((attempt: any) => attempt.tool_call_id === 'pending-1').state).toBe('interrupted');
    const final = await worker(directory, 3, epoch);
    expect(final.sessionEpoch).toBe(epoch ? 1 : 0);
    expect(final.event).toBe('completed');
    expect(final.calls).toEqual([]);
    expect(final.inboundCompleted).toBe(true);
    expect(JSON.stringify(final.request)).toContain('actual receipt done-2');
    expect(final.history.filter((message: any) => typeof message.content === 'string' && message.content.includes('Advance assigned work.'))).toHaveLength(1);
    expect(final.attempts.filter((attempt: any) => attempt.state === 'completed')).toHaveLength(2);
    expect(final.attempts.filter((attempt: any) => attempt.state === 'interrupted')).toHaveLength(2);
  }, 30000);

  it('loads history committed before a crash preceding the in-memory append', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gateway-tool-commit-'));
    directories.push(directory);
    const committed = await worker(directory, 4);
    expect(committed.event).toBe('committed');
    expect(committed.history.length).toBe(committed.memory.length + 1);
    const next = await worker(directory, 5);
    expect(JSON.stringify(next.request)).toContain('interrupted side effects require inspection');
    expect(next.calls).toEqual([]);
    expect(next.inboundCompleted).toBe(true);
    const messageId = committed.history.at(-1).id;
    expect(next.history.filter((message: any) => message.id === messageId)).toHaveLength(1);
  });

  it('does not execute or provider-fallback when the pre-execution audit fails', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gateway-tool-audit-'));
    directories.push(directory);
    const result = await worker(directory, 6);
    expect(result.calls).toEqual([]);
    expect(result.providerCalls).toBe(1);
    expect(JSON.stringify(result.history)).toContain('Outcome is unknown');
  });

  it('heartbeat does not auto-execute Pulse before the model turn', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gateway-heartbeat-crash-'));
    directories.push(directory);
    const first = await worker(directory, 1, 'heartbeat');
    expect(first.calls).toEqual([]);
    expect(first.attempts.filter((attempt: { name?: string }) =>
      String(attempt.name ?? '').includes('pulse_get_my_work'))).toEqual([]);
  });
});
