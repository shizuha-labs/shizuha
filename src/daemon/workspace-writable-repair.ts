import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureWritableSqliteDatabase } from './sqlite-writable-repair.js';

export type BareMetalWorkspaceRepairReport = {
  repairedPaths: string[];
  retainedLegacyDirectories: string[];
};

function isWritable(filePath: string): boolean {
  try {
    // Root bypasses ordinary mode-bit checks in access(2). Treat a path with no
    // write bit as legacy read-only even in CI, then use accessSync to preserve
    // the ownership/ACL check exercised by the unprivileged production daemon.
    if ((fs.statSync(filePath).mode & 0o222) === 0) return false;
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function privateCopy(source: string, destination: string): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      privateCopy(path.join(source, entry), path.join(destination, entry));
    }
    fs.chmodSync(destination, 0o700);
    return;
  }
  if (sourceStat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    return;
  }
  throw new Error(`unsupported legacy workspace artifact type: ${source}`);
}

function directoryTreeIsWritable(directoryPath: string): boolean {
  if (!isWritable(directoryPath)) return false;
  for (const entry of fs.readdirSync(directoryPath)) {
    const candidate = path.join(directoryPath, entry);
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory()) {
      if (!directoryTreeIsWritable(candidate)) return false;
    } else if (stat.isFile()) {
      if (!isWritable(candidate)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function repairRegularFile(filePath: string): boolean {
  if (!fs.existsSync(filePath) || isWritable(filePath)) return false;
  const parentDir = path.dirname(filePath);
  if (!isWritable(parentDir)) {
    throw new Error(`legacy runtime file is read-only and its parent is not writable: ${filePath}`);
  }

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const replacement = path.join(parentDir, `.${path.basename(filePath)}.writable-repair-${nonce}`);
  try {
    fs.copyFileSync(filePath, replacement, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(replacement, 0o600);
    const fd = fs.openSync(replacement, 'a');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(replacement, filePath);
    return true;
  } catch (error) {
    fs.rmSync(replacement, { force: true });
    throw error;
  }
}

function repairDirectoryTree(
  directoryPath: string,
): { repaired: boolean; retainedLegacyDirectory?: string } {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    return { repaired: false };
  }
  if (directoryTreeIsWritable(directoryPath)) return { repaired: false };

  const parentDir = path.dirname(directoryPath);
  if (!isWritable(parentDir)) {
    throw new Error(
      `legacy runtime directory is read-only and its parent cannot host a rootless repair: ${directoryPath}`,
    );
  }

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const baseName = path.basename(directoryPath);
  const replacement = path.join(parentDir, `.${baseName}.writable-repair-${nonce}`);
  const legacy = path.join(parentDir, `.${baseName}.readonly-legacy-${nonce}`);
  let sourceMoved = false;

  try {
    privateCopy(directoryPath, replacement);
    fs.renameSync(directoryPath, legacy);
    sourceMoved = true;
    fs.renameSync(replacement, directoryPath);
  } catch (error) {
    fs.rmSync(replacement, { recursive: true, force: true });
    if (sourceMoved && !fs.existsSync(directoryPath)) {
      try { fs.renameSync(legacy, directoryPath); } catch { /* preserve original at legacy path */ }
    }
    throw error;
  }

  // An unprivileged daemon cannot delete a root-owned non-writable directory
  // tree even after moving it aside. Try to clean it; otherwise retain the
  // exact source as a recovery copy and report that fact explicitly.
  try {
    fs.rmSync(legacy, { recursive: true, force: true });
    return { repaired: true };
  } catch {
    return { repaired: true, retainedLegacyDirectory: legacy };
  }
}

/**
 * Preflight every mutable artifact owned by a bare-metal SCLI runtime.
 *
 * This is intentionally a narrow allow-list. Agent workspaces may also contain
 * user project files, which the daemon must never recursively chown or rewrite.
 */
export async function repairBareMetalRuntimeWorkspace(
  workspace: string,
  primaryStateDatabase: string | null,
): Promise<BareMetalWorkspaceRepairReport> {
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  if (!isWritable(workspace)) {
    throw new Error(`bare-metal workspace is not writable: ${workspace}`);
  }

  const repairedPaths: string[] = [];
  const retainedLegacyDirectories: string[] = [];

  for (const directoryName of ['cron', 'memory']) {
    const result = repairDirectoryTree(path.join(workspace, directoryName));
    if (result.repaired) repairedPaths.push(directoryName);
    if (result.retainedLegacyDirectory) {
      retainedLegacyDirectories.push(result.retainedLegacyDirectory);
    }
  }

  const databaseNames = new Set<string>(['.memory-index.db']);
  if (primaryStateDatabase) databaseNames.add(primaryStateDatabase);
  for (const databaseName of databaseNames) {
    const result = await ensureWritableSqliteDatabase(path.join(workspace, databaseName));
    if (result === 'repaired') repairedPaths.push(databaseName);
  }

  for (const fileName of [
    '.telemetry.jsonl',
    '.audit-log.jsonl',
    '.bridge-context-prompt',
    'HEARTBEAT.md',
  ]) {
    if (repairRegularFile(path.join(workspace, fileName))) repairedPaths.push(fileName);
  }

  return { repairedPaths, retainedLegacyDirectories };
}
