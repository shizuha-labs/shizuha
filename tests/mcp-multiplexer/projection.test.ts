import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MCP_PROJECTION_PROTOCOL_PREFIX,
  ProjectionAuthority,
  canonicalizeProjectionJson,
  loadProjectionHighWater,
  projectionSigningPreimage,
  storeProjectionHighWater,
  verifyMcpProjectionEnvelope,
  type McpProjectionClaims,
} from '../../src/mcp-multiplexer/projection.js';

const fixtures: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of fixtures.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function signingFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const kid = 'test-ed25519-v1';
  const keyring = JSON.stringify({
    keys: [{ current: true, kid, public_key: der.subarray(-32).toString('base64url') }],
    schema_version: 1,
  });
  return { privateKey, kid, keyring };
}

function signedEnvelope(input: {
  nonce: Buffer;
  privateKey: crypto.KeyObject;
  kid: string;
  generation?: number;
  services?: string[];
  issuedAt?: number;
  expiresAt?: number;
  leaseDeadline?: number;
  audience?: string;
}) {
  const issuedAt = input.issuedAt ?? 100_000;
  const claims: McpProjectionClaims = {
    agent_audience: input.audience ?? 'agent-1',
    catalog_version: 7,
    expires_at: input.expiresAt ?? issuedAt + 5_000,
    fingerprint: 'a'.repeat(64),
    generation: input.generation ?? 1,
    issued_at: issuedAt,
    kid: input.kid,
    lease_deadline: input.leaseDeadline ?? issuedAt + 5_000,
    mcp_services: input.services ?? ['pulse'],
    schema_version: 1,
    source: 'hive',
  };
  const signature = crypto.sign(null, projectionSigningPreimage(input.nonce, claims), input.privateKey);
  return canonicalizeProjectionJson({
    nonce: input.nonce.toString('base64url'), projection: claims,
    signature: signature.toString('base64url'),
  });
}

describe('PLAT-5275 MCP projection verifier', () => {
  it('uses the exact domain-separated canonical signing preimage', () => {
    const nonce = Buffer.alloc(32, 1);
    const { privateKey, kid } = signingFixture();
    const raw = signedEnvelope({ nonce, privateKey, kid });
    const projection = JSON.parse(raw).projection as McpProjectionClaims;
    expect(projectionSigningPreimage(nonce, projection)).toEqual(Buffer.concat([
      Buffer.from(MCP_PROJECTION_PROTOCOL_PREFIX), Buffer.from([0]), nonce, Buffer.from([0]),
      Buffer.from(canonicalizeProjectionJson(projection)),
    ]));
  });

  it('accepts a valid current-nonce envelope with non-zero immediate authority', () => {
    const nonce = crypto.randomBytes(32);
    const { privateKey, kid, keyring } = signingFixture();
    const verified = verifyMcpProjectionEnvelope({
      rawEnvelope: signedEnvelope({ nonce, privateKey, kid }), expectedNonce: nonce,
      expectedAudience: 'agent-1', pinnedKeyringJson: keyring,
      sSlowMs: 500, wallNowMs: 100_000, monoNowMs: 7_000,
    });
    expect(verified.allowedServices.has('pulse')).toBe(true);
    expect(verified.monoDeadlineMs).toBe(11_500);
  });

  it.each([
    ['wrong nonce', (raw: string) => raw, Buffer.alloc(32, 2), 'nonce mismatch'],
    ['wrong audience', (raw: string) => raw, null, 'agent_audience mismatch'],
    ['bad signature', (raw: string) => {
      const match = raw.match(/"signature":"([^"]+)"/);
      if (!match) return raw;
      const flipped = Buffer.from(match[1], 'base64url');
      flipped[0] ^= 0xff;
      return raw.replace(`"signature":"${match[1]}"`, `"signature":"${flipped.toString('base64url')}"`);
    }, null, 'signature verification failed'],
    ['non-canonical whitespace', (raw: string) => `${raw}\n`, null, 'not canonical'],
    ['duplicate key', (raw: string) => raw.replace('{', '{"nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",'), null, 'not canonical'],
  ])('rejects %s', (_name, mutate, nonceOverride, message) => {
    const nonce = Buffer.alloc(32, 1);
    const fixture = signingFixture();
    const audience = _name === 'wrong audience' ? 'agent-2' : 'agent-1';
    expect(() => verifyMcpProjectionEnvelope({
      rawEnvelope: mutate(signedEnvelope({ nonce, privateKey: fixture.privateKey, kid: fixture.kid })),
      expectedNonce: nonceOverride ?? nonce, expectedAudience: audience,
      pinnedKeyringJson: fixture.keyring, wallNowMs: 100_000, monoNowMs: 1_000,
    })).toThrow(message);
  });

  it.each([
    [['pulse', 'admin'], 'sorted and unique'],
    [['pulse', 'pulse'], 'sorted and unique'],
    [[], 'must not be empty'],
  ])('rejects non-canonical service set %j', (services, message) => {
    const nonce = crypto.randomBytes(32);
    const fixture = signingFixture();
    expect(() => verifyMcpProjectionEnvelope({
      rawEnvelope: signedEnvelope({ nonce, privateKey: fixture.privateKey, kid: fixture.kid, services }),
      expectedNonce: nonce, expectedAudience: 'agent-1', pinnedKeyringJson: fixture.keyring,
      wallNowMs: 100_000, monoNowMs: 1_000,
    })).toThrow(message);
  });

  it('subtracts slow-clock uncertainty from delayed delivery without a dead control', () => {
    const nonce = crypto.randomBytes(32);
    const fixture = signingFixture();
    const verified = verifyMcpProjectionEnvelope({
      rawEnvelope: signedEnvelope({
        nonce, privateKey: fixture.privateKey, kid: fixture.kid,
        issuedAt: 100_000, expiresAt: 105_000, leaseDeadline: 105_000,
      }),
      expectedNonce: nonce, expectedAudience: 'agent-1', pinnedKeyringJson: fixture.keyring,
      sSlowMs: 5_000, wallNowMs: 99_900, monoNowMs: 1_000,
    });
    expect(verified.monoDeadlineMs - verified.verifiedAtMonoMs).toBe(100);
    expect(verified.allowedServices.has('pulse')).toBe(true);
  });

  it('rejects expired, non-positive and overlong signed intervals', () => {
    const nonce = crypto.randomBytes(32);
    const fixture = signingFixture();
    for (const [expiresAt, wallNow] of [[99_999, 100_000], [100_000, 100_000]]) {
      expect(() => verifyMcpProjectionEnvelope({
        rawEnvelope: signedEnvelope({ nonce, privateKey: fixture.privateKey, kid: fixture.kid, issuedAt: 100_000, expiresAt }),
        expectedNonce: nonce, expectedAudience: 'agent-1', pinnedKeyringJson: fixture.keyring,
        sSlowMs: 0, wallNowMs: wallNow!, monoNowMs: 1_000,
      })).toThrow('lifetime is non-positive');
    }
    expect(() => verifyMcpProjectionEnvelope({
      rawEnvelope: signedEnvelope({
        nonce, privateKey: fixture.privateKey, kid: fixture.kid,
        issuedAt: 100_000, expiresAt: 106_000, leaseDeadline: 106_000,
      }),
      expectedNonce: nonce, expectedAudience: 'agent-1', pinnedKeyringJson: fixture.keyring,
      sSlowMs: 0, wallNowMs: 100_000, monoNowMs: 1_000,
    })).toThrow('projection lifetime exceeds five seconds');
  });

  it('persists the generation high-water across a cold authority restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plat5275-'));
    fixtures.push(directory);
    const file = path.join(directory, 'high-water.json');
    const fixture = signingFixture();
    const clock = { wallNowMs: () => 100_000, monoNowMs: () => 1_000 };
    const authority = (generation: number) => new ProjectionAuthority({
      agentAudience: 'agent-1', pinnedKeyringJson: fixture.keyring, clock,
      fetchEnvelope: async (nonce) => signedEnvelope({ nonce, privateKey: fixture.privateKey, kid: fixture.kid, generation }),
      loadHighWater: () => loadProjectionHighWater(file),
      storeHighWater: (value) => storeProjectionHighWater(value, file),
    });
    const first = authority(2);
    await first.start();
    first.stop();
    expect(loadProjectionHighWater(file)).toBe(2);
    await expect(authority(1).start()).rejects.toThrow('generation rollback');
  });

  it('rejects replayed and omitted nonces plus stale signing keys', () => {
    const currentNonce = crypto.randomBytes(32);
    const replayedNonce = crypto.randomBytes(32);
    const current = signingFixture();
    const stale = signingFixture();
    const staleKeyring = stale.keyring.replace('\"current\":true', '\"current\":false');
    expect(() => verifyMcpProjectionEnvelope({
      rawEnvelope: signedEnvelope({ nonce: replayedNonce, privateKey: current.privateKey, kid: current.kid }),
      expectedNonce: currentNonce, expectedAudience: 'agent-1', pinnedKeyringJson: current.keyring,
      wallNowMs: 100_000, monoNowMs: 1_000,
    })).toThrow('nonce mismatch');
    expect(() => verifyMcpProjectionEnvelope({
      rawEnvelope: canonicalizeProjectionJson({
        projection: JSON.parse(signedEnvelope({ nonce: currentNonce, privateKey: current.privateKey, kid: current.kid })).projection,
        signature: 'A'.repeat(86),
      }),
      expectedNonce: currentNonce, expectedAudience: 'agent-1', pinnedKeyringJson: current.keyring,
      wallNowMs: 100_000, monoNowMs: 1_000,
    })).toThrow('envelope fields mismatch');
    expect(() => verifyMcpProjectionEnvelope({
      rawEnvelope: signedEnvelope({ nonce: currentNonce, privateKey: stale.privateKey, kid: stale.kid }),
      expectedNonce: currentNonce, expectedAudience: 'agent-1', pinnedKeyringJson: staleKeyring,
      wallNowMs: 100_000, monoNowMs: 1_000,
    })).toThrow('no current key');
  });

  it('fences immediately on refresh refusal and at monotonic expiry despite wall jumps', async () => {
    let mono = 1_000;
    let wall = 100_000;
    let fail = false;
    const fixture = signingFixture();
    const authority = new ProjectionAuthority({
      agentAudience: 'agent-1', pinnedKeyringJson: fixture.keyring,
      clock: { wallNowMs: () => wall, monoNowMs: () => mono },
      fetchEnvelope: async (nonce) => {
        if (fail) throw new Error('silent stall');
        return signedEnvelope({ nonce, privateKey: fixture.privateKey, kid: fixture.kid });
      },
      loadHighWater: () => -1, storeHighWater: () => {},
    });
    await authority.start();
    expect(authority.isAllowed('pulse')).toBe(true);
    wall = 1; // backward wall jump cannot move the immutable monotonic fence.
    mono = 5_501;
    expect(authority.isAllowed('pulse')).toBe(false);
    mono = 1_000; wall = 100_000; fail = true;
    await expect(authority.refresh()).rejects.toThrow('silent stall');
    expect(authority.snapshot().state).toBe('fenced');
  });
});
