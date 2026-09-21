import pino, { type Logger } from 'pino';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Transform, Writable } from 'node:stream';

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
  private dirReady = false;

  constructor(filePath: string, maxBytes: number, maxFiles: number) {
    super();
    this.filePath = filePath;
    this.maxBytes = Math.max(1024, maxBytes);
    this.maxFiles = Math.max(1, maxFiles);

    // SCLI-557: directory creation is DEFERRED to the first actual record
    // write (see ensureDir). Creating `~/.config/shizuha/logs/` at stream
    // construction mutated HOME for every CLI invocation — including commands
    // that reject their input preflight and emit nothing (provision-agent
    // invalid-input matrix), violating the SCLI-557 zero-HOME-mutation
    // contract. Writability is still probed eagerly by createFileLogger (see
    // canCreateDirUnder) so the SCLI-410 unwritable-HOME → $TMPDIR fallback
    // keeps working without touching the filesystem.
    this.on('error', () => { /* never crash the CLI on a log-sink failure */ });
    try {
      this.currentSize = fs.statSync(this.filePath).size;
    } catch {
      this.currentSize = 0;
    }
  }

  private ensureDir(): void {
    if (this.dirReady) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.dirReady = true;
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
      this.ensureDir();
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

/**
 * Non-mutating writability probe for a log directory (SCLI-557): walk up to
 * the nearest EXISTING ancestor and require write+search permission there.
 * Unlike an eager mkdirSync this leaves the filesystem untouched, so a CLI
 * run that never emits a log record creates nothing, while createFileLogger
 * can still refuse an unwritable candidate and let its callers fall back to
 * $TMPDIR (SCLI-410 unwritable-HOME contract).
 */
function canCreateDirUnder(dirPath: string): boolean {
  let probe = dirPath;
  for (;;) {
    try {
      fs.accessSync(probe, fs.constants.W_OK | fs.constants.X_OK);
      return fs.statSync(probe).isDirectory();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) return false;
        probe = parent;
        continue;
      }
      return false;
    }
  }
}

// SCLI-6xx (operator 2026-09-18): mirror structured log lines to stdout so the
// fleet's alloy/Loki pipeline captures the SCLI activity log permanently. The
// in-pod shizuha.log lives in an emptyDir and dies at hibernation — a
// line-by-line inspection of a since-hibernated seat (agent-log-inspection
// doctrine) previously had NO evidence to read. Mirrored lines are stamped
// with "src":"scli" so Loki queries isolate them from other container stdout:
//   {pod=~"agent-X.*"} | json | src="scli"
// Gated by SCLI_LOG_STDOUT_MIRROR=1 (set in the agent-runtime entrypoint);
// never active for local TUI sessions where stdout is the terminal.
class StdoutMirrorTransform extends Transform {
  constructor() {
    super({ transform(chunk: Buffer, _enc, cb) {
      // pino emits one JSON object per write; stamp the copy without
      // corrupting non-JSON fragments (defensive: pass those through).
      const text = chunk.toString('utf8');
      if (text.startsWith('{')) {
        cb(null, text.replace('{', '{"src":"scli",'));
      } else {
        cb(null, chunk);
      }
    } });
  }
}

function stdoutMirrorStream(): Writable | null {
  if (process.env['SCLI_LOG_STDOUT_MIRROR'] !== '1') return null;
  return new StdoutMirrorTransform();
}

function createFileLogger(level: string, filePath: string, mirrorToStderr = false): Logger {
  // Preserve the SCLI-410 fallback contract without eager mutation: refuse an
  // unwritable candidate here (callers try/continue to $TMPDIR) instead of
  // letting the stream's deferred first-write mkdir discover it later.
  if (!canCreateDirUnder(path.dirname(filePath))) {
    throw new Error(`unwritable log directory: ${path.dirname(filePath)}`);
  }
  const maxBytes = parsePositiveInt(process.env['SHIZUHA_LOG_MAX_BYTES'], DEFAULT_LOG_MAX_BYTES);
  const maxFiles = parsePositiveInt(process.env['SHIZUHA_LOG_MAX_FILES'], DEFAULT_LOG_MAX_FILES);
  const fileStream = new RotatingFileStream(filePath, maxBytes, maxFiles);

  const streams: Array<{ level: string; stream: Writable | NodeJS.WriteStream }> = [
    { level, stream: fileStream },
  ];
  if (mirrorToStderr) {
    streams.push({ level, stream: process.stderr });
  }
  const stdoutMirror = stdoutMirrorStream();
  if (stdoutMirror) {
    streams.push({ level, stream: stdoutMirror });
    stdoutMirror.pipe(process.stdout);
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
