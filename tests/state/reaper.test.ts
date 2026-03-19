import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MaintenanceReaper } from '../../src/gateway/reaper.js';
import { StateStore } from '../../src/state/store.js';

describe('MaintenanceReaper', () => {
  let tmpDir: string;
  let spillDir: string;
  let queueDir: string;
  let failedDir: string;
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-test-'));
    spillDir = path.join(tmpDir, 'spill');
    queueDir = path.join(tmpDir, 'delivery-queue');
    failedDir = path.join(tmpDir, 'delivery-queue', 'failed');
    fs.mkdirSync(spillDir, { recursive: true });
    fs.mkdirSync(failedDir, { recursive: true });

    dbPath = path.join(tmpDir, 'state.db');
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createOldFile(dir: string, name: string, ageMs: number): void {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, '{}');
    const oldTime = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, oldTime, oldTime);
  }

  function createRecentFile(dir: string, name: string): void {
    fs.writeFileSync(path.join(dir, name), '{}');
  }

  it('cleans old spill files and keeps recent ones', async () => {
    // Old spill file (2 days)
    createOldFile(spillDir, 'old-tool-use.txt', 2 * 86_400_000);
    // Recent spill file
    createRecentFile(spillDir, 'recent-tool-use.txt');

    const reaper = new MaintenanceReaper(
      { spillMaxAgeMs: 86_400_000 },
      { store, failedDir, queueDir },
    );
    // Override the spill dir to our test one
    (reaper as any).spillDir = spillDir;

    const stats = await reaper.sweep();

    expect(stats.spillFilesRemoved).toBe(1);
    expect(fs.existsSync(path.join(spillDir, 'old-tool-use.txt'))).toBe(false);
    expect(fs.existsSync(path.join(spillDir, 'recent-tool-use.txt'))).toBe(true);
  });

  it('cleans old failed delivery entries and keeps recent ones', async () => {
    createOldFile(failedDir, 'old-delivery.json', 8 * 86_400_000); // 8 days
    createRecentFile(failedDir, 'recent-delivery.json');

    const reaper = new MaintenanceReaper(
      { failedMaxAgeMs: 7 * 86_400_000 },
      { store, failedDir, queueDir },
    );
    (reaper as any).spillDir = spillDir;

    const stats = await reaper.sweep();

    expect(stats.failedEntriesRemoved).toBe(1);
    expect(fs.existsSync(path.join(failedDir, 'old-delivery.json'))).toBe(false);
    expect(fs.existsSync(path.join(failedDir, 'recent-delivery.json'))).toBe(true);
  });

  it('cleans stale .tmp files from delivery queue', async () => {
    createOldFile(queueDir, 'stale.tmp', 2 * 3_600_000); // 2 hours old
    createRecentFile(queueDir, 'fresh.tmp');
    // .json files should not be touched
    createOldFile(queueDir, 'pending.json', 2 * 3_600_000);

    const reaper = new MaintenanceReaper(
      { tmpMaxAgeMs: 3_600_000 },
      { store, failedDir, queueDir },
    );
    (reaper as any).spillDir = spillDir;

    const stats = await reaper.sweep();

    expect(stats.tmpFilesRemoved).toBe(1);
    expect(fs.existsSync(path.join(queueDir, 'stale.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(queueDir, 'fresh.tmp'))).toBe(true);
    expect(fs.existsSync(path.join(queueDir, 'pending.json'))).toBe(true);
  });

  it('prunes old interrupt checkpoints', async () => {
    // Create a session and add an old checkpoint
    const session = store.createSession('test-model', '/tmp/test');
    const oldTime = Date.now() - 8 * 86_400_000; // 8 days ago
    store.saveInterruptCheckpoint(session.id, {
      createdAt: oldTime,
      promptExcerpt: 'old prompt',
      note: 'old note',
    });

    // Create another session with a recent checkpoint
    const session2 = store.createSession('test-model', '/tmp/test2');
    store.saveInterruptCheckpoint(session2.id, {
      createdAt: Date.now(),
      promptExcerpt: 'recent prompt',
      note: 'recent note',
    });

    const reaper = new MaintenanceReaper(
      { checkpointMaxAgeMs: 7 * 86_400_000 },
      { store, failedDir, queueDir },
    );
    (reaper as any).spillDir = spillDir;

    const stats = await reaper.sweep();

    expect(stats.checkpointsRemoved).toBe(1);
    // Verify the old checkpoint is gone
    const loaded1 = store.loadSession(session.id);
    expect(loaded1?.interruptCheckpoint).toBeUndefined();
    // Verify the recent checkpoint is still there
    const loaded2 = store.loadSession(session2.id);
    expect(loaded2?.interruptCheckpoint).toBeDefined();
  });

  it('runs VACUUM on first sweep', async () => {
    const reaper = new MaintenanceReaper(
      { vacuumIntervalMs: 86_400_000 },
      { store, failedDir, queueDir },
    );
    (reaper as any).spillDir = spillDir;

    const stats = await reaper.sweep();
    expect(stats.vacuumed).toBe(true);

    // Second sweep should NOT vacuum (too soon)
    const stats2 = await reaper.sweep();
    expect(stats2.vacuumed).toBe(false);
  });

  it('handles missing directories gracefully', async () => {
    const reaper = new MaintenanceReaper(undefined, {
      store,
      failedDir: '/nonexistent/path/failed',
      queueDir: '/nonexistent/path/queue',
    });
    (reaper as any).spillDir = '/nonexistent/path/spill';

    // Should not throw
    const stats = await reaper.sweep();
    expect(stats.spillFilesRemoved).toBe(0);
    expect(stats.failedEntriesRemoved).toBe(0);
    expect(stats.tmpFilesRemoved).toBe(0);
  });

  it('handles no store gracefully', async () => {
    const reaper = new MaintenanceReaper(undefined, {
      failedDir,
      queueDir,
      // no store
    });
    (reaper as any).spillDir = spillDir;

    const stats = await reaper.sweep();
    expect(stats.checkpointsRemoved).toBe(0);
    expect(stats.vacuumed).toBe(false);
  });

  it('start() and stop() manage timer lifecycle', () => {
    const reaper = new MaintenanceReaper(
      { intervalMs: 60_000 },
      { store, failedDir, queueDir },
    );

    reaper.start();
    expect((reaper as any).timer).not.toBeNull();

    // Double-start should be idempotent
    reaper.start();

    reaper.stop();
    expect((reaper as any).timer).toBeNull();

    // Double-stop should be safe
    reaper.stop();
  });
});
