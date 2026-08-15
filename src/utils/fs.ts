import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Resolve and validate a file path is within the allowed directory */
export function resolveSafePath(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, filePath);
  // Basic safety: don't escape the filesystem root
  if (!resolved.startsWith('/')) {
    throw new Error(`Invalid path: ${filePath}`);
  }
  return resolved;
}

/** Read a file with size limit */
export async function readFileSafe(
  filePath: string,
  options?: { offset?: number; limit?: number },
): Promise<{ content: string; totalLines: number }> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`);
  }

  const raw = await fs.readFile(filePath, 'utf-8');
  const lines = raw.split('\n');
  const totalLines = lines.length;

  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? lines.length;
  const slice = lines.slice(offset, offset + limit);

  // Format like cat -n
  const content = slice
    .map((line, i) => {
      const lineNum = offset + i + 1;
      return `${String(lineNum).padStart(6)}\t${line}`;
    })
    .join('\n');

  return { content, totalLines };
}

/**
 * Write a file atomically — write to .tmp then rename.
 * Crash between write and rename leaves only a .tmp file (no data loss).
 * Creates parent directories as needed.
 */
export async function writeFileSafe(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = filePath + '.shizuha.tmp';
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath); // atomic on local FS
}

/** Check if a path exists */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a bridge workspace before any session, token, telemetry, or gateway
 * initialization can use it (SCLI-493 / SCLI-529).
 *
 * Symlinks to directories are accepted and canonicalized. Empty values,
 * missing paths, regular files, FIFOs, and dangling symlinks fail with one
 * bounded diagnostic that always names `--cwd` and never exposes a raw fs
 * stack. The JSON-quoted path keeps control characters on that single line.
 */
export function assertWorkspaceDir(cwd: string | undefined): string {
  const raw = cwd ?? '';
  if (raw.trim() === '') {
    throw new Error(
      `--cwd must be an existing directory; received ${JSON.stringify(raw)} (empty or whitespace-only)`,
    );
  }

  let realPath: string;
  try {
    realPath = fsSync.realpathSync(raw);
  } catch {
    throw new Error(
      `--cwd must be an existing directory; received ${JSON.stringify(raw)} (path does not resolve)`,
    );
  }

  let stat: fsSync.Stats;
  try {
    stat = fsSync.statSync(realPath);
  } catch {
    throw new Error(
      `--cwd must be an existing directory; received ${JSON.stringify(raw)} (path does not resolve)`,
    );
  }
  if (!stat.isDirectory()) {
    const kind = stat.isFile() ? 'regular file' : 'not a directory';
    throw new Error(
      `--cwd must be an existing directory; received ${JSON.stringify(raw)} (${kind})`,
    );
  }

  return realPath;
}
