import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const MAX_MAPPING_BYTES = 64 * 1024;
const invalidConfiguration = (): Error => new Error('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');

/** User-owned installation data, never project/workspace configuration. */
function privateHumanEmailConfiguration(): string | undefined {
  const base = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  if (!path.isAbsolute(base)) throw invalidConfiguration();
  const filename = path.join(base, 'shizuha', 'pulse-human-emails.json');
  let fd: number | undefined;
  try {
    // Refuse symlinks anywhere in the selected path before reading installation data.
    const absolute = path.resolve(filename);
    const segments = absolute.slice(path.parse(absolute).root.length).split(path.sep);
    let current = path.parse(absolute).root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let info: fs.Stats;
      try { info = fs.lstatSync(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      if (info.isSymbolicLink()) throw invalidConfiguration();
      if (current !== absolute && !info.isDirectory()) throw invalidConfiguration();
    }
    const before = fs.lstatSync(filename);
    const safe = (info: fs.Stats): boolean => info.isFile()
      && info.size <= MAX_MAPPING_BYTES
      && (process.platform === 'win32' || (
        info.uid === process.getuid?.() && (info.mode & 0o077) === 0
      ));
    if (!safe(before)) throw invalidConfiguration();
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (!safe(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw invalidConfiguration();
    // Bound the read too: a file that grows after stat cannot allocate an unbounded buffer.
    const buffer = Buffer.alloc(MAX_MAPPING_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    if (bytes > MAX_MAPPING_BYTES) throw invalidConfiguration();
    return buffer.subarray(0, bytes).toString('utf8');
  } catch {
    throw invalidConfiguration();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Explicit deployment-owned human routing; no installation's mailbox ships in code. */
export function humanEmailMapping(): Record<string, string> {
  // Even an explicitly empty environment value overrides the local installation file.
  const explicit = process.env['SHIZUHA_PULSE_HUMAN_EMAILS'];
  const configured = explicit !== undefined ? explicit : privateHumanEmailConfiguration();
  if (configured === undefined || (explicit !== undefined && configured === '')) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(configured); } catch { throw new Error('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const mailboxes = new Set<string>();
  for (const [username, email] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]+$/.test(username) || typeof email !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || mailboxes.has(email)) {
      throw new Error('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
    }
    result[username] = email;
    mailboxes.add(email);
  }
  return result;
}

export function pulseEmailFor(username: string): string {
  return humanEmailMapping()[username] ?? `${username}@agents.shizuha.io`;
}

export function pulseUsernameFor(email: string): string {
  return Object.entries(humanEmailMapping()).find(([, mailbox]) => mailbox === email)?.[0]
    ?? email.split('@')[0] ?? email;
}
