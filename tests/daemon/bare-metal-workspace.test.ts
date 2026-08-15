import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_STATE_DB_BASENAME,
  launchBareMetalChild,
  planWorkspaceStateRepairs,
  preflightBareMetalWorkspaceState,
  WorkspaceStatePreflightError,
} from '../../src/daemon/bare-metal-workspace.js';

const roots: string[] = [];

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-368-'));
  roots.push(root);
  return path.join(root, 'fumi');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SCLI-368 bare-metal SQLite workspace preflight', () => {
  it('plans a narrow ownership repair for a root-created DB and its sidecars', () => {
    const workspace = '/home/phoenix/.shizuha/workspaces/fumi';
    const db = `${workspace}/${AGENT_STATE_DB_BASENAME}`;
    const plan = planWorkspaceStateRepairs([
      { path: workspace, kind: 'workspace', uid: 1000, gid: 1000, mode: 0o755 },
      { path: db, kind: 'sqlite-state', uid: 0, gid: 0, mode: 0o644 },
      { path: `${db}-wal`, kind: 'sqlite-state', uid: 0, gid: 0, mode: 0o644 },
      { path: `${db}-shm`, kind: 'sqlite-state', uid: 0, gid: 0, mode: 0o644 },
    ], 1000, 1000);

    expect(plan.ownershipPaths).toEqual([db, `${db}-wal`, `${db}-shm`]);
    expect(plan.modePaths).toEqual([workspace, db, `${db}-wal`, `${db}-shm`]);
    expect(plan.ownershipPaths.every((candidate) => candidate.startsWith(`${workspace}/.shizuha-state.db`)))
      .toBe(true);
  });

  it('runs the real child-launch boundary twice and preserves database bytes', () => {
    const workspace = tempWorkspace();
    fs.mkdirSync(workspace, { recursive: true, mode: 0o755 });
    const db = path.join(workspace, AGENT_STATE_DB_BASENAME);
    const wal = `${db}-wal`;
    fs.writeFileSync(db, 'valid sqlite fixture bytes');
    fs.writeFileSync(wal, 'valid wal fixture bytes');
    fs.chmodSync(db, 0o400);
    fs.chmodSync(wal, 0o400);

    const launches: string[] = [];
    const fakeFork = ((script: string, args: readonly string[], options: { cwd?: string }) => {
      expect(script).toBe('/opt/shizuha/dist/shizuha.js');
      expect(args).toEqual(['gateway']);
      expect(options.cwd).toBe(workspace);
      launches.push('fork');
      return { pid: launches.length };
    }) as never;

    // Production order: top-level start preflight -> fork, child exits, then
    // supervisor recreate runs the same top-level preflight -> replacement fork.
    const first = launchBareMetalChild({
      workspaceDir: workspace,
      shizuhaJs: '/opt/shizuha/dist/shizuha.js',
      args: ['gateway'],
      env: {},
      forkProcess: fakeFork,
    });
    const second = launchBareMetalChild({
      workspaceDir: workspace,
      shizuhaJs: '/opt/shizuha/dist/shizuha.js',
      args: ['gateway'],
      env: {},
      forkProcess: fakeFork,
    });

    expect(launches).toEqual(['fork', 'fork']);
    expect(first.preflight.repairedModes).toEqual([workspace, db, wal]);
    expect(second.preflight.repairedOwnership).toEqual([]);
    expect(second.preflight.repairedModes).toEqual([]);
    expect(fs.readFileSync(db, 'utf8')).toBe('valid sqlite fixture bytes');
    expect(fs.readFileSync(wal, 'utf8')).toBe('valid wal fixture bytes');
    expect(fs.statSync(db).mode & 0o777).toBe(0o600);
    expect(fs.statSync(wal).mode & 0o777).toBe(0o600);
  });

  it('fails closed before launch when an allow-listed state entry is a symlink', () => {
    const workspace = tempWorkspace();
    fs.mkdirSync(workspace, { recursive: true });
    const outside = path.join(path.dirname(workspace), 'outside.db');
    fs.writeFileSync(outside, 'do not touch');
    fs.symlinkSync(outside, path.join(workspace, AGENT_STATE_DB_BASENAME));

    expect(() => preflightBareMetalWorkspaceState(workspace)).toThrow(WorkspaceStatePreflightError);
    expect(fs.readFileSync(outside, 'utf8')).toBe('do not touch');
  });

  it('fails closed on a broken SQLite state symlink', () => {
    const workspace = tempWorkspace();
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync('/does/not/exist', path.join(workspace, AGENT_STATE_DB_BASENAME));

    expect(() => preflightBareMetalWorkspaceState(workspace)).toThrow(WorkspaceStatePreflightError);
  });

  it('does not fork when the production launch boundary fails preflight', () => {
    const workspace = tempWorkspace();
    fs.mkdirSync(workspace, { recursive: true });
    const outside = path.join(path.dirname(workspace), 'outside.db');
    fs.writeFileSync(outside, 'do not touch');
    fs.symlinkSync(outside, path.join(workspace, AGENT_STATE_DB_BASENAME));
    let forks = 0;

    expect(() => launchBareMetalChild({
      workspaceDir: workspace,
      shizuhaJs: '/opt/shizuha/dist/shizuha.js',
      args: ['gateway'],
      env: {},
      forkProcess: (() => { forks += 1; return {} as never; }) as never,
    })).toThrow(WorkspaceStatePreflightError);
    expect(forks).toBe(0);
  });
});
