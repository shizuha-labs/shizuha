import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { repairBareMetalRuntimeWorkspace } from '../../src/daemon/workspace-writable-repair.js';

function makeReadOnlyTreeWritable(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) {
    try { fs.chmodSync(target, 0o600); } catch { /* best effort cleanup */ }
    return;
  }
  try { fs.chmodSync(target, 0o700); } catch { /* best effort cleanup */ }
  for (const entry of fs.readdirSync(target)) {
    makeReadOnlyTreeWritable(path.join(target, entry));
  }
}

describe('repairBareMetalRuntimeWorkspace', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      makeReadOnlyTreeWritable(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempWorkspace(): string {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-writable-repair-'));
    tempDirs.push(workspace);
    return workspace;
  }

  it('preserves logs, cron jobs, and memory DB data while making them writable', async () => {
    const workspace = tempWorkspace();
    fs.writeFileSync(path.join(workspace, '.telemetry.jsonl'), '{"event":"kept"}\n');
    fs.writeFileSync(path.join(workspace, '.audit-log.jsonl'), '{"tool":"kept"}\n');
    fs.chmodSync(path.join(workspace, '.telemetry.jsonl'), 0o444);
    fs.chmodSync(path.join(workspace, '.audit-log.jsonl'), 0o444);

    const cronDir = path.join(workspace, 'cron');
    fs.mkdirSync(cronDir);
    fs.writeFileSync(path.join(cronDir, 'jobs.json'), '{"jobs":[{"id":"kept"}]}');
    fs.chmodSync(path.join(cronDir, 'jobs.json'), 0o444);
    fs.chmodSync(cronDir, 0o555);

    const memoryDir = path.join(workspace, 'memory');
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'notes.md'), 'preserved\n');
    fs.chmodSync(path.join(memoryDir, 'notes.md'), 0o444);

    const memoryDbPath = path.join(workspace, '.memory-index.db');
    const memoryDb = new Database(memoryDbPath);
    memoryDb.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('preserved')");
    memoryDb.close();
    fs.chmodSync(memoryDbPath, 0o444);

    const report = await repairBareMetalRuntimeWorkspace(workspace, '.shizuha-state.db');

    expect(report.repairedPaths).toEqual(expect.arrayContaining([
      'cron',
      'memory',
      '.memory-index.db',
      '.telemetry.jsonl',
      '.audit-log.jsonl',
    ]));
    expect(fs.readFileSync(path.join(workspace, '.telemetry.jsonl'), 'utf8')).toBe('{"event":"kept"}\n');
    expect(fs.readFileSync(path.join(workspace, '.audit-log.jsonl'), 'utf8')).toBe('{"tool":"kept"}\n');
    expect(JSON.parse(fs.readFileSync(path.join(cronDir, 'jobs.json'), 'utf8')).jobs[0].id).toBe('kept');
    expect(fs.readFileSync(path.join(memoryDir, 'notes.md'), 'utf8')).toBe('preserved\n');
    expect(() => fs.writeFileSync(path.join(cronDir, 'jobs.json.tmp'), '{}')).not.toThrow();
    expect(() => fs.appendFileSync(path.join(workspace, '.telemetry.jsonl'), '{}\n')).not.toThrow();
    const verify = new Database(memoryDbPath);
    expect(verify.prepare('SELECT value FROM proof').pluck().get()).toBe('preserved');
    expect(() => verify.exec("INSERT INTO proof VALUES ('writable')")).not.toThrow();
    verify.close();
  });

  it('is idempotent once every runtime artifact is writable', async () => {
    const workspace = tempWorkspace();
    fs.mkdirSync(path.join(workspace, 'cron'));
    fs.mkdirSync(path.join(workspace, 'memory'));
    fs.writeFileSync(path.join(workspace, '.telemetry.jsonl'), '');

    const first = await repairBareMetalRuntimeWorkspace(workspace, '.shizuha-state.db');
    const second = await repairBareMetalRuntimeWorkspace(workspace, '.shizuha-state.db');

    expect(first.repairedPaths).toEqual([]);
    expect(second).toEqual({ repairedPaths: [], retainedLegacyDirectories: [] });
  });
});
