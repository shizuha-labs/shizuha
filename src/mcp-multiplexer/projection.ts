/**
 * PLAT-5275 trusted MCP projection challenge/response verifier.
 *
 * The UDS is intentionally treated as an untrusted transport.  Authorization
 * comes only from an Ed25519 signature by a pinned current producer over a
 * fresh child nonce and one RFC-8785-compatible canonical projection object.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const MCP_PROJECTION_PROTOCOL_PREFIX = 'shizuha-hive-projection/v1';
export const MCP_PROJECTION_SCHEMA_VERSION = 1;
export const MCP_PROJECTION_AUDIENCE = 'shizuha-mcp-multiplexer';
export const MCP_PROJECTION_MAX_LIFETIME_MS = 5_000;
export const MCP_PROJECTION_DEFAULT_S_SLOW_MS = 500;
export const MCP_PROJECTION_DEFAULT_LEASE_MS = 5_000;
export const MCP_PROJECTION_REFRESH_MARGIN_MS = 250;
const DEFAULT_BROKER_SOCKET = '/run/shizuha/mcp-auth-proxy/proxy.sock';
export const PINNED_MCP_PROJECTION_KEYRING_FILE = '/run/shizuha/mcp-projection/keyring.json';
const PROJECTION_HIGH_WATER_FILE = path.join(
  os.homedir(), '.shizuha', 'authority', 'mcp-projection-high-water.json',
);
const SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HEX64_RE = /^(?:sha256:)?[a-f0-9]{64}$/;

export type ProjectionAuthorityState = 'verified' | 'expired' | 'fenced' | 'unverified';

export interface McpProjectionClaims {
  schema_version: 1;
  source: 'hive';
  mcp_services: string[];
  fingerprint: string;
  catalog_version: string | number;
  agent_audience: string;
  issued_at: number;
  expires_at: number;
  generation: number;
  lease_deadline: number;
  kid: string;
}

export interface McpProjectionEnvelope {
  projection: McpProjectionClaims;
  nonce: string;
  signature: string;
}

export interface McpProjectionKey {
  kid: string;
  public_key: string;
  current?: boolean;
}

export interface McpProjectionKeyring {
  schema_version: 1;
  keys: McpProjectionKey[];
}

export interface ProjectionClock {
  wallNowMs(): number;
  monoNowMs(): number;
}

export interface VerifiedMcpProjection {
  claims: McpProjectionClaims;
  allowedServices: ReadonlySet<string>;
  verifiedAtWallMs: number;
  verifiedAtMonoMs: number;
  monoDeadlineMs: number;
  sSlowMs: number;
}

export interface ProjectionAuthoritySnapshot {
  state: ProjectionAuthorityState;
  reason: string;
  verified: VerifiedMcpProjection | null;
}

function reject(message: string): never {
  throw new Error(`mcp_projection_invalid: ${message}`);
}

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    reject(`${field} must be a plain object`);
  }
}

/**
 * RFC 8785 uses ECMAScript JSON number/string serialization and recursively
 * sorted object keys.  The projection contract deliberately admits only the
 * interoperable integer subset, avoiding non-finite/negative-zero edge cases.
 */
export function canonicalizeProjectionJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) reject('numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeProjectionJson).join(',')}]`;
  }
  assertPlainObject(value, 'canonical value');
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalizeProjectionJson(value[key])}`
  ).join(',')}}`;
}

export function projectionSigningPreimage(nonce: Buffer, projection: McpProjectionClaims): Buffer {
  if (nonce.length !== 32) reject('nonce must be exactly 32 raw bytes');
  return Buffer.concat([
    Buffer.from(MCP_PROJECTION_PROTOCOL_PREFIX, 'ascii'),
    Buffer.from([0]),
    nonce,
    Buffer.from([0]),
    Buffer.from(canonicalizeProjectionJson(projection), 'utf8'),
  ]);
}

function parseTimestampMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) reject(`${field} must be a positive epoch-millisecond integer`);
  return value;
}

function parseGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject('generation must be a non-negative integer');
  return value;
}

function parseServices(value: unknown): string[] {
  if (!Array.isArray(value)) reject('mcp_services must be an array');
  const services = value.map((item) => {
    if (typeof item !== 'string' || !SERVICE_RE.test(item)) reject('mcp_services contains an invalid service name');
    return item;
  });
  if (services.length > 64 || services.some((item, index) => index > 0 && item <= services[index - 1]!)) {
    reject('mcp_services must be sorted and unique');
  }
  if (services.length === 0) reject('mcp_services must not be empty');
  return services;
}

export function parseStrictProjection(raw: string | Buffer): McpProjectionEnvelope {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (!text || Buffer.byteLength(text, 'utf8') > 64 * 1024) reject('envelope size is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    reject(`malformed JSON: ${(err as Error).message}`);
  }
  // JSON.parse otherwise silently retains the last duplicate key.  Requiring
  // the exact canonical envelope bytes makes every duplicate, alternate key
  // order, or insignificant whitespace encoding fail closed before verify.
  if (canonicalizeProjectionJson(parsed) !== text) reject('envelope is not canonical or contains duplicate keys');
  assertPlainObject(parsed, 'envelope');
  if (Object.keys(parsed).sort().join(',') !== 'nonce,projection,signature') reject('envelope fields mismatch');
  const projectionValue = parsed['projection'];
  assertPlainObject(projectionValue, 'projection');
  const fields = [
    'agent_audience', 'catalog_version', 'expires_at', 'fingerprint', 'generation',
    'issued_at', 'kid', 'lease_deadline', 'mcp_services', 'schema_version', 'source',
  ];
  if (Object.keys(projectionValue).sort().join(',') !== fields.join(',')) reject('projection fields mismatch');
  const catalog = projectionValue['catalog_version'];
  if (!(typeof catalog === 'string' && catalog.length > 0 && catalog.length <= 128)
      && !(typeof catalog === 'number' && Number.isSafeInteger(catalog) && catalog >= 0)) reject('catalog_version is invalid');
  const claims: McpProjectionClaims = {
    schema_version: projectionValue['schema_version'] === MCP_PROJECTION_SCHEMA_VERSION ? 1 : reject('schema_version unsupported'),
    source: projectionValue['source'] === 'hive' ? 'hive' : reject('source must be hive'),
    mcp_services: parseServices(projectionValue['mcp_services']),
    fingerprint: typeof projectionValue['fingerprint'] === 'string' && HEX64_RE.test(projectionValue['fingerprint'])
      ? projectionValue['fingerprint'] : reject('fingerprint is invalid'),
    catalog_version: catalog as string | number,
    agent_audience: typeof projectionValue['agent_audience'] === 'string' && projectionValue['agent_audience'].length > 0
      ? projectionValue['agent_audience'] : reject('agent_audience is invalid'),
    issued_at: parseTimestampMs(projectionValue['issued_at'], 'issued_at'),
    expires_at: parseTimestampMs(projectionValue['expires_at'], 'expires_at'),
    generation: parseGeneration(projectionValue['generation']),
    lease_deadline: parseTimestampMs(projectionValue['lease_deadline'], 'lease_deadline'),
    kid: typeof projectionValue['kid'] === 'string' && KID_RE.test(projectionValue['kid'])
      ? projectionValue['kid'] : reject('kid is invalid'),
  };
  const nonce = parsed['nonce'];
  const signature = parsed['signature'];
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) reject('nonce is invalid');
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) reject('signature is invalid');
  return { projection: claims, nonce, signature };
}

function rawEd25519PublicKey(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) reject('Ed25519 public key must be 32 raw bytes');
  // RFC 8410 SubjectPublicKeyInfo prefix for id-Ed25519.
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der', type: 'spki',
  });
}

export function parsePinnedMcpProjectionKeyring(raw: string): Map<string, crypto.KeyObject> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { reject('pinned keyring JSON malformed'); }
  assertPlainObject(parsed, 'keyring');
  if (Object.keys(parsed).sort().join(',') !== 'keys,schema_version'
      || parsed['schema_version'] !== 1 || !Array.isArray(parsed['keys'])) reject('pinned keyring schema invalid');
  const keys = new Map<string, crypto.KeyObject>();
  for (const item of parsed['keys']) {
    assertPlainObject(item, 'keyring key');
    if (Object.keys(item).sort().join(',') !== 'current,kid,public_key') reject('keyring key fields mismatch');
    if (typeof item['kid'] !== 'string' || !KID_RE.test(item['kid'])) reject('keyring kid invalid');
    if (typeof item['current'] !== 'boolean') reject('keyring current invalid');
    if (!item['current']) continue;
    if (typeof item['public_key'] !== 'string') reject('keyring public_key invalid');
    if (keys.has(item['kid'])) reject('duplicate current keyring kid');
    if (!/^[A-Za-z0-9_-]{43}$/.test(item['public_key'])) reject('keyring public_key invalid');
    const publicKey = Buffer.from(item['public_key'], 'base64url');
    keys.set(item['kid'], rawEd25519PublicKey(publicKey));
  }
  if (keys.size === 0) reject('pinned keyring has no current key');
  return keys;
}

export function verifyMcpProjectionEnvelope(input: {
  rawEnvelope: string | Buffer;
  expectedNonce: Buffer;
  expectedAudience: string;
  pinnedKeyringJson: string;
  sSlowMs?: number;
  wallNowMs: number;
  monoNowMs: number;
}): VerifiedMcpProjection {
  const envelope = parseStrictProjection(input.rawEnvelope);
  const nonce = Buffer.from(envelope.nonce, 'base64url');
  if (nonce.length !== input.expectedNonce.length || !crypto.timingSafeEqual(nonce, input.expectedNonce)) reject('nonce mismatch');
  const keyring = parsePinnedMcpProjectionKeyring(input.pinnedKeyringJson);
  const key = keyring.get(envelope.projection.kid);
  if (!key) reject('kid is stale or unknown');
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (!crypto.verify(null, projectionSigningPreimage(nonce, envelope.projection), key, signature)) reject('signature verification failed');
  if (envelope.projection.agent_audience !== input.expectedAudience) reject('agent_audience mismatch');
  const sSlowMs = input.sSlowMs ?? MCP_PROJECTION_DEFAULT_S_SLOW_MS;
  if (!Number.isSafeInteger(sSlowMs) || sSlowMs < 0 || sSlowMs > MCP_PROJECTION_MAX_LIFETIME_MS) reject('local S_slow is invalid');
  if (!Number.isSafeInteger(input.wallNowMs) || !Number.isSafeInteger(input.monoNowMs)) reject('clock reading is ambiguous');
  const signedLifetimeMs = envelope.projection.expires_at - envelope.projection.issued_at;
  if (!Number.isSafeInteger(signedLifetimeMs) || signedLifetimeMs > MCP_PROJECTION_MAX_LIFETIME_MS) {
    reject('projection lifetime exceeds five seconds');
  }
  const remainingMs = Math.min(
    MCP_PROJECTION_MAX_LIFETIME_MS,
    signedLifetimeMs,
    envelope.projection.expires_at - input.wallNowMs - sSlowMs,
    envelope.projection.lease_deadline - input.wallNowMs - sSlowMs,
  );
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) reject('projection lifetime is non-positive');
  const monoDeadlineMs = input.monoNowMs + remainingMs;
  if (!Number.isSafeInteger(monoDeadlineMs)) reject('monotonic deadline overflow');
  return {
    claims: envelope.projection,
    allowedServices: new Set(envelope.projection.mcp_services),
    verifiedAtWallMs: input.wallNowMs,
    verifiedAtMonoMs: input.monoNowMs,
    monoDeadlineMs,
    sSlowMs,
  };
}

export class ProjectionAuthority {
  private snapshotValue: ProjectionAuthoritySnapshot = { state: 'unverified', reason: 'not_started', verified: null };
  private highestGeneration = -1;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: {
    agentAudience: string;
    pinnedKeyringJson: string;
    fetchEnvelope: (nonce: Buffer) => Promise<string | Buffer>;
    clock?: ProjectionClock;
    sSlowMs?: number;
    refreshMarginMs?: number;
    loadHighWater?: () => number;
    storeHighWater?: (generation: number) => void;
  }) {}

  snapshot(): ProjectionAuthoritySnapshot {
    const current = this.snapshotValue;
    if (current.verified && this.clock().monoNowMs() >= current.verified.monoDeadlineMs) {
      this.clear('expired', 'monotonic_deadline_elapsed');
    }
    return this.snapshotValue;
  }

  isAllowed(service: string): boolean {
    const current = this.snapshot();
    return current.state === 'verified' && !!current.verified?.allowedServices.has(service);
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      this.highestGeneration = this.options.loadHighWater?.() ?? loadProjectionHighWater();
    } catch (err) {
      this.clear('fenced', (err as Error).message);
      throw err;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const work = this.doRefresh();
    this.refreshInFlight = work;
    try { await work; } finally { this.refreshInFlight = null; }
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.clear('fenced', 'authority_stopped');
  }

  private clock(): ProjectionClock {
    return this.options.clock ?? {
      wallNowMs: () => Date.now(),
      monoNowMs: () => Math.round(performance.now()),
    };
  }

  private clear(state: ProjectionAuthorityState, reason: string): void {
    this.snapshotValue = { state, reason, verified: null };
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async doRefresh(): Promise<void> {
    if (this.stopped) return;
    const nonce = crypto.randomBytes(32);
    try {
      const raw = await this.options.fetchEnvelope(nonce);
      const clock = this.clock();
      // v10: capture the pair exactly once after the authentic response arrives.
      const wallNowMs = clock.wallNowMs();
      const monoNowMs = clock.monoNowMs();
      const verified = verifyMcpProjectionEnvelope({
        rawEnvelope: raw,
        expectedNonce: nonce,
        expectedAudience: this.options.agentAudience,
        pinnedKeyringJson: this.options.pinnedKeyringJson,
        sSlowMs: this.options.sSlowMs,
        wallNowMs,
        monoNowMs,
      });
      if (verified.claims.generation < this.highestGeneration) reject('generation rollback');
      if (verified.claims.generation > this.highestGeneration) {
        (this.options.storeHighWater ?? storeProjectionHighWater)(verified.claims.generation);
        this.highestGeneration = verified.claims.generation;
      }
      this.snapshotValue = { state: 'verified', reason: 'ok', verified };
      const margin = Math.max(1, Math.min(
        verified.monoDeadlineMs - monoNowMs - 1,
        this.options.refreshMarginMs ?? MCP_PROJECTION_REFRESH_MARGIN_MS,
      ));
      const delay = Math.max(1, verified.monoDeadlineMs - monoNowMs - margin);
      this.refreshTimer = setTimeout(() => { void this.refresh(); }, delay);
      this.refreshTimer.unref?.();
    } catch (err) {
      this.clear('fenced', (err as Error).message);
      throw err;
    }
  }
}

export function brokerProjectionSocket(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MCP_AUTH_PROXY_SOCKET'] ?? '').trim() || DEFAULT_BROKER_SOCKET;
}

export function fetchBrokerProjection(nonce: Buffer, env: NodeJS.ProcessEnv = process.env, timeoutMs = 2_000): Promise<Buffer> {
  const socketPath = brokerProjectionSocket(env);
  return new Promise((resolve, rejectPromise) => {
    const body = Buffer.from(JSON.stringify({ nonce: nonce.toString('base64url') }));
    const req = http.request({
      socketPath,
      path: '/mcp-projection',
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) req.destroy(new Error('mcp projection response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        const response = Buffer.concat(chunks);
        if (res.statusCode !== 200) rejectPromise(new Error(`mcp projection broker HTTP ${res.statusCode}: ${response.toString('utf8').slice(0, 200)}`));
        else resolve(response);
      });
    });
    req.once('timeout', () => req.destroy(new Error('mcp projection broker timeout')));
    req.once('error', rejectPromise);
    req.end(body);
  });
}

export function loadPinnedMcpProjectionKeyring(): string {
  // This fixed path is a daemon-owned read-only Secret projection. It is deliberately
  // NOT configurable through the child environment or writable workspace: an
  // attacker who can edit .mcp.json must never be able to replace the trust root.
  const stat = fs.statSync(PINNED_MCP_PROJECTION_KEYRING_FILE);
  if (!stat.isFile()) reject('pinned keyring path is not a file');
  const raw = fs.readFileSync(PINNED_MCP_PROJECTION_KEYRING_FILE, 'utf8');
  parsePinnedMcpProjectionKeyring(raw);
  return raw;
}

function parseHighWater(raw: string): number {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('projection high-water malformed');
  const generation = (value as Record<string, unknown>)['generation'];
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    reject('projection high-water generation invalid');
  }
  return generation;
}

export function loadProjectionHighWater(file = PROJECTION_HIGH_WATER_FILE): number {
  try {
    return parseHighWater(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return -1;
    throw err;
  }
}

export function storeProjectionHighWater(generation: number, file = PROJECTION_HIGH_WATER_FILE): void {
  if (!Number.isSafeInteger(generation) || generation < 0) reject('projection high-water generation invalid');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ generation })}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(tmp); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
