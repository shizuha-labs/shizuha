import pino, { type Logger } from 'pino';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Writable } from 'node:stream';

const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_LOG_MAX_FILES = 5;

let logLevel: string = process.env['SHIZUHA_LOG_LEVEL'] ?? 'info';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

class RotatingFileStream extends Writable {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private currentSize = 0;

  constructor(filePath: string, maxBytes: number, maxFiles: number) {
    super();
    this.filePath = filePath;
    this.maxBytes = Math.max(1024, maxBytes);
    this.maxFiles = Math.max(1, maxFiles);

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      this.currentSize = fs.statSync(this.filePath).size;
    } catch {
      this.currentSize = 0;
    }
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (this.currentSize + incomingBytes <= this.maxBytes) return;

    const oldest = `${this.filePath}.${this.maxFiles}`;
    if (fs.existsSync(oldest)) {
      try { fs.rmSync(oldest, { force: true }); } catch { /* ignore */ }
    }

    for (let idx = this.maxFiles - 1; idx >= 1; idx--) {
      const src = `${this.filePath}.${idx}`;
      const dst = `${this.filePath}.${idx + 1}`;
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dst); } catch { /* ignore */ }
      }
    }

    if (fs.existsSync(this.filePath)) {
      try { fs.renameSync(this.filePath, `${this.filePath}.1`); } catch { /* ignore */ }
    }
    this.currentSize = 0;
  }

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.rotateIfNeeded(buffer.length);
      fs.appendFileSync(this.filePath, buffer);
      this.currentSize += buffer.length;
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

function createStderrLogger(level: string): Logger {
  return pino({
    level,
    transport:
      process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino/file', options: { destination: 2 } }
        : undefined,
  });
}

function defaultLogPath(): string {
  return process.env['SHIZUHA_LOG_FILE']
    ?? path.join(process.env['HOME'] ?? '.', '.config', 'shizuha', 'logs', 'shizuha.log');
}

function createFileLogger(level: string, filePath: string, mirrorToStderr = false): Logger {
  const maxBytes = parsePositiveInt(process.env['SHIZUHA_LOG_MAX_BYTES'], DEFAULT_LOG_MAX_BYTES);
  const maxFiles = parsePositiveInt(process.env['SHIZUHA_LOG_MAX_FILES'], DEFAULT_LOG_MAX_FILES);
  const fileStream = new RotatingFileStream(filePath, maxBytes, maxFiles);

  const streams: Array<{ level: string; stream: Writable | NodeJS.WriteStream }> = [
    { level, stream: fileStream },
  ];
  if (mirrorToStderr) {
    streams.push({ level, stream: process.stderr });
  }

  return pino({ level }, pino.multistream(streams as never));
}

function createDiscardLogger(level: string): Logger {
  return pino({ level }, new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }));
}

function tmpLogPath(): string {
  const tmp = process.env['TMPDIR'] || process.env['TMP'] || process.env['TEMP'] || '/tmp';
  return path.join(tmp, 'shizuha', 'logs', 'shizuha.log');
}

// SCLI-410: structured logger records are TELEMETRY and must be ABSENT from
// stdout/stderr by default (a successful `shizuha -p` / `exec` run has
// byte-empty stderr and stdout that carries only the result/NDJSON). The
// default sink is the rotating file at defaultLogPath(); emitting to stderr
// requires an explicit opt-in (SHIZUHA_LOG_STDERR=1, e.g. --verbose debugging).
const STDERR_OPT_IN = ['1', 'true'].includes(
  String(process.env['SHIZUHA_LOG_STDERR'] ?? '').trim().toLowerCase(),
);

/**
 * File-first logger that must never throw. Unwritable HOME (container
 * HOME=/home/bench, tests with HOME=/nonexistent-...) used to crash the
 * process at import via mkdirSync, so `shizuha pulse list --json` produced
 * empty stdout. Fall back to $TMPDIR, then a discard sink — never stderr
 * (SCLI-410 quiet-success).
 */
export function createDefaultLogger(level: string, stderrOptIn = STDERR_OPT_IN): Logger {
  if (stderrOptIn) return createStderrLogger(level);
  for (const filePath of [defaultLogPath(), tmpLogPath()]) {
    try {
      return createFileLogger(level, filePath, /*mirrorToStderr=*/false);
    } catch {
      continue;
    }
  }
  return createDiscardLogger(level);
}

export function setLogLevel(level: string): void {
  logLevel = level;
  logger.level = level;
}

export let logger: Logger = createDefaultLogger(logLevel);

export function enableFileLogging(options?: {
  filePath?: string;
  level?: string;
  mirrorToStderr?: boolean;
}): string {
  const filePath = options?.filePath ?? defaultLogPath();
  const level = options?.level ?? logLevel;
  const mirrorToStderr = options?.mirrorToStderr ?? false;

  let used = filePath;
  let created: Logger | undefined;
  for (const candidate of [filePath, tmpLogPath()]) {
    try {
      created = createFileLogger(level, candidate, mirrorToStderr);
      used = candidate;
      break;
    } catch {
      continue;
    }
  }
  logger = created ?? createDiscardLogger(level);
  logLevel = level;
  logger.info({ filePath: used }, 'File logging enabled');
  return used;
}
