import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FleetSshCredentialGrant } from './agent-credential.js';
import type { AgentCredentialScope } from './types.js';
import type { AgentInfo } from './types.js';

export const CREDENTIAL_AUDIT_EVENT_TYPES = [
  'grant_issued',
  'grant_staged',
  'grant_revoked',
  'request_opened',
  'request_approved',
  'request_denied',
  'request_expired',
  'payload_read',
] as const;

export type CredentialAuditEventType = typeof CREDENTIAL_AUDIT_EVENT_TYPES[number];

export const CREDENTIAL_AUDIT_RETENTION_MS = 366 * 24 * 60 * 60 * 1000;
export const DEFAULT_CREDENTIAL_AUDIT_LOG_PATH = path.join(os.homedir(), '.shizuha', 'credential-audit.jsonl');
const CREDENTIAL_AUDIT_INDEX_VERSION = 2;

const SECRET_FIELD_PATTERN = /(?:credentialData|payload|token|secret|password|privateKey|accessKey|refreshToken)/i;

export interface CredentialAuditEvent extends Record<string, unknown> {
  id: string;
  event: CredentialAuditEventType;
  at: string;
  retentionExpiresAt: string;
  grantorId?: string;
  grantorAgentId?: string;
  grantorUsername?: string;
  granteeId?: string;
  granteeUsername?: string;
  scope?: AgentCredentialScope;
  customService?: string;
  grantId?: string;
  requestId?: string;
  reason?: string;
}

export interface CredentialAuditQuery {
  event?: CredentialAuditEventType | string;
  grantor?: string;
  grantee?: string;
  scope?: AgentCredentialScope | string;
  scopes?: Array<AgentCredentialScope | string>;
  customService?: string;
  from?: string;
  to?: string;
  limit?: number;
  useIndex?: boolean;
  requireIndex?: boolean;
}

function credentialAuditIndexMetaPath(logPath: string): string {
  return `${logPath}.index-meta.json`;
}

function credentialAuditKeyIndexDir(logPath: string, suffix: 'by-grantor' | 'by-grantee'): string {
  return `${logPath}.${suffix}.d`;
}

function credentialAuditKeyIndexPath(logPath: string, suffix: 'by-grantor' | 'by-grantee', key: string): string {
  const hash = crypto.createHash('sha256').update(key.trim().toLowerCase()).digest('hex');
  return path.join(credentialAuditKeyIndexDir(logPath, suffix), `${hash}.jsonl`);
}

function credentialAuditLogSize(logPath: string): number | undefined {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return undefined;
  }
}

function writeCredentialAuditIndexMeta(logPath: string): void {
  const logSize = credentialAuditLogSize(logPath);
  if (logSize === undefined) return;
  fs.writeFileSync(credentialAuditIndexMetaPath(logPath), JSON.stringify({
    version: CREDENTIAL_AUDIT_INDEX_VERSION,
    logSize,
    indexedAt: new Date().toISOString(),
  }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'w' });
}

function credentialAuditIndexesCurrent(logPath: string): boolean {
  const logSize = credentialAuditLogSize(logPath);
  if (logSize === undefined) return true;
  if (!fs.existsSync(`${logPath}.by-grantor.jsonl`) || !fs.existsSync(`${logPath}.by-grantee.jsonl`)) return false;
  if (!fs.existsSync(credentialAuditKeyIndexDir(logPath, 'by-grantor')) ||
      !fs.existsSync(credentialAuditKeyIndexDir(logPath, 'by-grantee'))) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(credentialAuditIndexMetaPath(logPath), 'utf8')) as { version?: unknown; logSize?: unknown };
    return meta.version === CREDENTIAL_AUDIT_INDEX_VERSION && meta.logSize === logSize;
  } catch {
    return false;
  }
}

function credentialAuditIndexEntries(keys: string[], event: CredentialAuditEvent): Array<{ key: string; row: string }> {
  const uniqueKeys = [...new Set(keys.map((key) => key.trim().toLowerCase()).filter(Boolean))];
  return uniqueKeys.map((key) => ({ key, row: JSON.stringify({
    key,
    eventId: event.id,
    event: event.event,
    at: event.at,
    scope: event.scope ?? null,
    scopes: Array.isArray(event.scopes) ? event.scopes : undefined,
    customService: event.customService,
    grantId: event.grantId,
    requestId: event.requestId,
  }) }));
}

function credentialAuditIndexRows(keys: string[], event: CredentialAuditEvent): string {
  const entries = credentialAuditIndexEntries(keys, event);
  if (!entries.length) return '';
  return entries.map((entry) => entry.row).join('\n') + '\n';
}

function appendCredentialAuditIndex(
  logPath: string,
  suffix: 'by-grantor' | 'by-grantee',
  keys: string[],
  event: CredentialAuditEvent,
): void {
  const indexPath = `${logPath}.${suffix}.jsonl`;
  fs.closeSync(fs.openSync(indexPath, 'a', 0o600));
  const entries = credentialAuditIndexEntries(keys, event);
  const indexRows = entries.map((entry) => entry.row).join('\n') + (entries.length ? '\n' : '');
  if (!indexRows) return;
  fs.appendFileSync(indexPath, indexRows, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  const keyIndexDir = credentialAuditKeyIndexDir(logPath, suffix);
  fs.mkdirSync(keyIndexDir, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    fs.appendFileSync(credentialAuditKeyIndexPath(logPath, suffix, entry.key), `${entry.row}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  }
  try {
    fs.chmodSync(indexPath, 0o600);
    fs.chmodSync(keyIndexDir, 0o700);
  } catch {
    // Best effort: chmod may fail on filesystems that do not support POSIX modes.
  }
}

export function credentialAuditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['SHIZUHA_CREDENTIAL_AUDIT_LOG'];
  return configured && configured.trim() ? configured.trim() : DEFAULT_CREDENTIAL_AUDIT_LOG_PATH;
}

function normalizeEventType(value: unknown): CredentialAuditEventType {
  if (typeof value !== 'string' || !CREDENTIAL_AUDIT_EVENT_TYPES.includes(value as CredentialAuditEventType)) {
    throw new Error(`Unsupported credential audit event: ${String(value)}`);
  }
  return value as CredentialAuditEventType;
}

function sanitizeAuditEvent(input: Record<string, unknown>): CredentialAuditEvent {
  const at = typeof input.at === 'string' && Number.isFinite(Date.parse(input.at))
    ? input.at
    : new Date().toISOString();
  const retentionExpiresAt = typeof input.retentionExpiresAt === 'string' && Number.isFinite(Date.parse(input.retentionExpiresAt))
    ? input.retentionExpiresAt
    : new Date(Date.parse(at) + CREDENTIAL_AUDIT_RETENTION_MS).toISOString();
  const event: Record<string, unknown> = {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : crypto.randomUUID(),
    event: normalizeEventType(input.event),
    at,
    retentionExpiresAt,
  };
  for (const [key, value] of Object.entries(input)) {
    if (key in event) continue;
    if (key === 'requireAuditIndex') continue;
    if (SECRET_FIELD_PATTERN.test(key)) continue;
    if (value === undefined) continue;
    event[key] = value;
  }
  return event as CredentialAuditEvent;
}

export function appendCredentialAuditEvent(
  logPath: string,
  input: Record<string, unknown>,
): CredentialAuditEvent {
  const requireAuditIndex = input.requireAuditIndex === true;
  const event = sanitizeAuditEvent(input);
  const indexesWereCurrentBeforeAppend = credentialAuditIndexesCurrent(logPath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  try {
    appendCredentialAuditIndex(
      logPath,
      'by-grantor',
      identities(event, ['grantorId', 'grantorAgentId', 'grantorUsername', 'actor', 'actorAgentId', 'actorUsername']),
      event,
    );
    appendCredentialAuditIndex(
      logPath,
      'by-grantee',
      identities(event, ['granteeId', 'granteeUsername', 'targetAgentId', 'targetAgent', 'targetUsername']),
      event,
    );
    if (indexesWereCurrentBeforeAppend) writeCredentialAuditIndexMeta(logPath);
  } catch {
    if (requireAuditIndex) {
      const err = new Error('credential audit sidecar index append failed');
      (err as { credentialAuditCommittedEvents?: number }).credentialAuditCommittedEvents = 1;
      throw err;
    }
    // The main audit log is authoritative and append-only. Sidecar indexes are
    // accelerators only, so a post-commit index failure must not make callers
    // roll back durable state while the authoritative row remains committed.
  }
  try {
    fs.chmodSync(logPath, 0o600);
  } catch {
    // Best effort: chmod may fail on filesystems that do not support POSIX modes.
  }
  return event;
}

export function createCredentialAuditLogger(logPath = credentialAuditLogPath()): (event: Record<string, unknown>) => void {
  return (event) => {
    appendCredentialAuditEvent(logPath, event);
  };
}

export function recordFleetSshGrantStagedAuditEvent(
  recordAuditEvent: (event: Record<string, unknown>) => void,
  agent: Pick<AgentInfo, 'id' | 'username'>,
  grant: FleetSshCredentialGrant,
  stagedFiles: number,
  at = new Date().toISOString(),
): void {
  recordAuditEvent({
    event: 'grant_staged',
    grantId: grant.grantId,
    granteeId: agent.id,
    granteeUsername: agent.username,
    scope: 'fleet-ssh',
    stagedFiles,
    at,
  });
}

function parsedDate(value: string | undefined, field: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid ISO timestamp`);
  return parsed;
}

function identities(event: CredentialAuditEvent, keys: string[]): string[] {
  return keys
    .map((key) => event[key])
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.toLowerCase());
}

function rebuildCredentialAuditIndexes(logPath: string): void {
  if (!fs.existsSync(logPath)) return;
  let grantorRows = '';
  let granteeRows = '';
  const grantorRowsByKey = new Map<string, string[]>();
  const granteeRowsByKey = new Map<string, string[]>();
  const collectRows = (
    rowsByKey: Map<string, string[]>,
    keys: string[],
    event: CredentialAuditEvent,
  ): string => {
    const entries = credentialAuditIndexEntries(keys, event);
    for (const entry of entries) {
      const rows = rowsByKey.get(entry.key) ?? [];
      rows.push(entry.row);
      rowsByKey.set(entry.key, rows);
    }
    return entries.length ? entries.map((entry) => entry.row).join('\n') + '\n' : '';
  };
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CredentialAuditEvent;
      grantorRows += collectRows(
        grantorRowsByKey,
        identities(parsed, ['grantorId', 'grantorAgentId', 'grantorUsername', 'actor', 'actorAgentId', 'actorUsername']),
        parsed,
      );
      granteeRows += collectRows(
        granteeRowsByKey,
        identities(parsed, ['granteeId', 'granteeUsername', 'targetAgentId', 'targetAgent', 'targetUsername']),
        parsed,
      );
    } catch {
      // Keep index backfill resilient to a partially written/truncated final line.
    }
  }
  for (const [suffix, rows] of [
    ['by-grantor', grantorRows],
    ['by-grantee', granteeRows],
  ] as const) {
    const indexPath = `${logPath}.${suffix}.jsonl`;
    const tempPath = `${indexPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(tempPath, rows, { encoding: 'utf8', mode: 0o600, flag: 'w' });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // Best effort: chmod may fail on filesystems that do not support POSIX modes.
    }
    fs.renameSync(tempPath, indexPath);
  }
  for (const [suffix, rowsByKey] of [
    ['by-grantor', grantorRowsByKey],
    ['by-grantee', granteeRowsByKey],
  ] as const) {
    const keyIndexDir = credentialAuditKeyIndexDir(logPath, suffix);
    fs.rmSync(keyIndexDir, { recursive: true, force: true });
    fs.mkdirSync(keyIndexDir, { recursive: true, mode: 0o700 });
    for (const [key, rows] of rowsByKey) {
      fs.writeFileSync(credentialAuditKeyIndexPath(logPath, suffix, key), rows.join('\n') + '\n', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'w',
      });
    }
    try {
      fs.chmodSync(keyIndexDir, 0o700);
    } catch {
      // Best effort: chmod may fail on filesystems that do not support POSIX modes.
    }
  }
  writeCredentialAuditIndexMeta(logPath);
}

function queryMatches(event: CredentialAuditEvent, query: CredentialAuditQuery, from?: number, to?: number): boolean {
  const eventAt = Date.parse(event.at);
  if (!Number.isFinite(eventAt)) return false;
  if (from !== undefined && eventAt < from) return false;
  if (to !== undefined && eventAt > to) return false;
  if (query.event && event.event !== query.event) return false;
  if (query.scope) {
    const requestedScope = String(query.scope);
    const scopes = [event.scope, ...(Array.isArray(event.scopes) ? event.scopes : [])].filter(Boolean).map(String);
    if (!scopes.includes(requestedScope)) return false;
  }
  if (query.scopes?.length) {
    const allowedScopes = new Set(query.scopes.map(String));
    const scopes = [event.scope, ...(Array.isArray(event.scopes) ? event.scopes : [])].filter(Boolean).map(String);
    if (!scopes.length || !scopes.every((scope) => allowedScopes.has(scope))) return false;
  }
  if (query.customService) {
    if (typeof event.customService !== 'string' || event.customService !== query.customService) return false;
  }
  if (query.grantor) {
    const grantor = query.grantor.toLowerCase();
    const candidates = identities(event, ['grantorId', 'grantorAgentId', 'grantorUsername', 'actor', 'actorAgentId', 'actorUsername']);
    if (!candidates.includes(grantor)) return false;
  }
  if (query.grantee) {
    const grantee = query.grantee.toLowerCase();
    const candidates = identities(event, ['granteeId', 'granteeUsername', 'targetAgentId', 'targetAgent', 'targetUsername']);
    if (!candidates.includes(grantee)) return false;
  }
  return true;
}

interface CredentialAuditIndexRow {
  key?: unknown;
  eventId?: unknown;
  event?: unknown;
  at?: unknown;
  scope?: unknown;
  scopes?: unknown;
  customService?: unknown;
  grantId?: unknown;
  requestId?: unknown;
}

function indexRowMatches(row: CredentialAuditIndexRow, query: CredentialAuditQuery, from?: number, to?: number): boolean {
  if (typeof row.key !== 'string') return false;
  const eventAt = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
  if (!Number.isFinite(eventAt)) return false;
  if (from !== undefined && eventAt < from) return false;
  if (to !== undefined && eventAt > to) return false;
  if (query.event && row.event !== query.event) return false;
  if (query.scope) {
    const requestedScope = String(query.scope);
    const scopes = [row.scope, ...(Array.isArray(row.scopes) ? row.scopes : [])].filter(Boolean).map(String);
    if (!scopes.includes(requestedScope)) return false;
  }
  if (query.scopes?.length) {
    const allowedScopes = new Set(query.scopes.map(String));
    const scopes = [row.scope, ...(Array.isArray(row.scopes) ? row.scopes : [])].filter(Boolean).map(String);
    if (!scopes.length || !scopes.every((scope) => allowedScopes.has(scope))) return false;
  }
  if (query.customService) {
    if (row.customService !== query.customService) return false;
  }
  return true;
}

function indexedAuditEvent(
  row: CredentialAuditIndexRow,
  suffix: 'by-grantor' | 'by-grantee',
  identity: string,
): CredentialAuditEvent {
  const event: Record<string, unknown> = {
    id: typeof row.eventId === 'string' && row.eventId.trim() ? row.eventId : crypto.randomUUID(),
    event: row.event,
    at: row.at,
    retentionExpiresAt: row.at,
    scope: row.scope,
    scopes: row.scopes,
    customService: row.customService,
    grantId: row.grantId,
    requestId: row.requestId,
  };
  if (suffix === 'by-grantor') {
    event.grantorId = identity;
    event.grantorAgentId = identity;
    event.grantorUsername = identity;
  } else {
    event.granteeId = identity;
    event.granteeUsername = identity;
  }
  return event as CredentialAuditEvent;
}

function readCredentialAuditKeyIndexTail(
  indexPath: string,
  visitLine: (line: string) => boolean,
): void {
  const fd = fs.openSync(indexPath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const chunkSize = 64 * 1024;
    let position = size;
    let carry = '';
    while (position > 0) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, buffer, 0, readSize, position);
      const chunk = buffer.toString('utf8') + carry;
      const lines = chunk.split(/\r?\n/);
      carry = lines.shift() ?? '';
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!.trim();
        if (line && !visitLine(line)) return;
      }
    }
    const finalLine = carry.trim();
    if (finalLine) visitLine(finalLine);
  } finally {
    fs.closeSync(fd);
  }
}

function queryCredentialAuditIndex(
  logPath: string,
  suffix: 'by-grantor' | 'by-grantee',
  identity: string,
  query: CredentialAuditQuery,
  from?: number,
  to?: number,
  limit = 1000,
): CredentialAuditEvent[] {
  const indexPath = `${logPath}.${suffix}.jsonl`;
  if (query.requireIndex && !credentialAuditIndexesCurrent(logPath)) {
    rebuildCredentialAuditIndexes(logPath);
  } else if (!fs.existsSync(indexPath)) {
    if (!fs.existsSync(logPath)) return [];
  }
  if (!fs.existsSync(indexPath)) {
    if (query.requireIndex) throw new Error(`credential audit ${suffix} index is not available`);
    return [];
  }
  const normalizedIdentity = identity.toLowerCase();
  const keyIndexPath = credentialAuditKeyIndexPath(logPath, suffix, normalizedIdentity);
  if (!fs.existsSync(keyIndexPath)) return [];
  const events: CredentialAuditEvent[] = [];
  readCredentialAuditKeyIndexTail(keyIndexPath, (line) => {
    try {
      const row = JSON.parse(line) as CredentialAuditIndexRow;
      const eventAt = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
      if (from !== undefined && Number.isFinite(eventAt) && eventAt < from) return false;
      if (typeof row.key !== 'string' || row.key.toLowerCase() !== normalizedIdentity) return true;
      if (indexRowMatches(row, query, from, to)) events.push(indexedAuditEvent(row, suffix, identity));
      return events.length < limit;
    } catch {
      // Keep queries resilient to a partially written/truncated final line.
      return true;
    }
  });
  return events.reverse();
}

export function queryCredentialAuditLog(logPath: string, query: CredentialAuditQuery = {}): CredentialAuditEvent[] {
  const from = parsedDate(query.from, 'from');
  const to = parsedDate(query.to, 'to');
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 1000);
  if (query.useIndex && query.grantor) {
    if (query.grantee) throw new Error('indexed credential audit queries do not support combined grantor and grantee filters');
    return queryCredentialAuditIndex(logPath, 'by-grantor', query.grantor, query, from, to, limit);
  }
  if (query.useIndex && query.grantee) {
    return queryCredentialAuditIndex(logPath, 'by-grantee', query.grantee, query, from, to, limit);
  }
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const events: CredentialAuditEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CredentialAuditEvent;
      if (queryMatches(parsed, query, from, to)) events.push(parsed);
    } catch {
      // Keep queries resilient to a partially written/truncated final line.
    }
  }
  return events.slice(-limit);
}
