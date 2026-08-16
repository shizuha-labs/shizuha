// PLAT-166 / ADR-PLAT-002 §5.2 — per-branch failure-mode tests for the credential
// broker's JWKS token verifier. akira's review focus: deny-by-default proven on
// EACH failing branch independently, not just the happy path.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  base64url,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import {
  JwksTokenVerifier,
  TokenVerificationError,
  type TokenVerificationCode,
} from '../../src/daemon/jwks-token-verifier.js';

const ISS = 'https://id.shizuha.test/';
const AUD = 'shizuha-credential-broker';
const KID = 'rs-key-1';
const EDKID = 'ed-key-1';

let rsPriv: CryptoKey;
let edPriv: CryptoKey;
let otherRsPriv: CryptoKey; // valid key NOT published in the JWKS (bad-sig source)
let jwks: JWTVerifyGetKey;

async function pubJwk(publicKey: CryptoKey, kid: string, alg: string): Promise<JWK> {
  return { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
}

beforeAll(async () => {
  const rs = await generateKeyPair('RS256');
  const ed = await generateKeyPair('EdDSA');
  const other = await generateKeyPair('RS256');
  rsPriv = rs.privateKey;
  edPriv = ed.privateKey;
  otherRsPriv = other.privateKey;
  // Published JWKS = RS public (kid=KID) + Ed public (kid=EDKID). `other` is NOT here.
  jwks = createLocalJWKSet({
    keys: [await pubJwk(rs.publicKey, KID, 'RS256'), await pubJwk(ed.publicKey, EDKID, 'EdDSA')],
  });
});

interface MintOpts {
  key: CryptoKey;
  alg: string;
  kid?: string;
  iss?: string;
  aud?: string;
  sub?: string | undefined;
  scope?: string;
  expIn?: string | number; // jose setExpirationTime arg
  setExp?: boolean;
}

async function mint(o: MintOpts): Promise<string> {
  const jwt = new SignJWT({ ...(o.scope !== undefined ? { scope: o.scope } : {}) })
    .setProtectedHeader({ alg: o.alg, kid: o.kid ?? KID })
    .setIssuedAt()
    .setIssuer(o.iss ?? ISS)
    .setAudience(o.aud ?? AUD);
  if (o.sub !== undefined) jwt.setSubject(o.sub);
  if (o.setExp !== false) jwt.setExpirationTime(o.expIn ?? '2h');
  return jwt.sign(o.key);
}

function verifier(overrides: Partial<ConstructorParameters<typeof JwksTokenVerifier>[0]> = {}) {
  return new JwksTokenVerifier({ jwks, issuer: ISS, audience: AUD, ...overrides });
}

async function expectDeny(p: Promise<unknown>, code: TokenVerificationCode) {
  await expect(p).rejects.toBeInstanceOf(TokenVerificationError);
  await p.catch((e) => expect((e as TokenVerificationError).code).toBe(code));
}

describe('JwksTokenVerifier — happy paths', () => {
  it('accepts a valid RS256 token and returns subject + scopes', async () => {
    const v = verifier();
    const token = await mint({ key: rsPriv, alg: 'RS256', sub: 'agent:ryo', scope: 'github docker' });
    const res = await v.verify(token);
    expect(res.subject).toBe('agent:ryo');
    expect(res.alg).toBe('RS256');
    expect(res.scopes).toEqual(['github', 'docker']);
  });

  it('accepts a valid EdDSA token', async () => {
    const v = verifier();
    const token = await mint({ key: edPriv, alg: 'EdDSA', kid: EDKID, sub: 'agent:kai' });
    const res = await v.verify(token);
    expect(res.subject).toBe('agent:kai');
    expect(res.alg).toBe('EdDSA');
  });
});

describe('JwksTokenVerifier — constructor guards (cannot install HS*/none)', () => {
  it('rejects HS256 in the allowlist', () => {
    expect(() => verifier({ algorithms: ['RS256', 'HS256'] })).toThrow(/disallowed algorithm "HS256"/);
  });
  it("rejects 'none' in the allowlist", () => {
    expect(() => verifier({ algorithms: ['none'] })).toThrow(/disallowed algorithm "none"/);
  });
  it('rejects an empty allowlist', () => {
    expect(() => verifier({ algorithms: [] })).toThrow(/must not be empty/);
  });
  it('requires exactly one of jwksUri | jwks', () => {
    expect(() => new JwksTokenVerifier({ issuer: ISS, audience: AUD })).toThrow(/exactly one/);
    expect(
      () => new JwksTokenVerifier({ issuer: ISS, audience: AUD, jwks, jwksUri: 'https://x/jwks.json' }),
    ).toThrow(/exactly one/);
  });
});

describe('JwksTokenVerifier — per-branch deny-by-default', () => {
  it('rejects an HS256-signed token (alg-confusion)', async () => {
    const secret = new TextEncoder().encode('x'.repeat(32));
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .setIssuedAt()
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject('agent:ryo')
      .setExpirationTime('2h')
      .sign(secret);
    await expectDeny(verifier().verify(token), 'alg_not_allowed');
  });

  it("rejects an unsecured 'none' token", async () => {
    const header = base64url.encode(JSON.stringify({ alg: 'none', kid: KID }));
    const payload = base64url.encode(
      JSON.stringify({ iss: ISS, aud: AUD, sub: 'agent:ryo', exp: Math.floor(Date.now() / 1000) + 3600 }),
    );
    const token = `${header}.${payload}.`;
    await expectDeny(verifier().verify(token), 'alg_not_allowed');
  });

  it('rejects an unknown kid (kid miss)', async () => {
    const token = await mint({ key: otherRsPriv, alg: 'RS256', kid: 'no-such-kid', sub: 'agent:ryo' });
    await expectDeny(verifier().verify(token), 'kid_not_found');
  });

  it('rejects a bad signature (known kid, wrong key)', async () => {
    // kid=KID resolves to the published RS public key, but signed with otherRsPriv.
    const token = await mint({ key: otherRsPriv, alg: 'RS256', kid: KID, sub: 'agent:ryo' });
    await expectDeny(verifier().verify(token), 'bad_signature');
  });

  it('rejects an expired token', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject('agent:ryo')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(rsPriv);
    await expectDeny(verifier({ clockToleranceSec: 0 }).verify(token), 'expired');
  });

  it('rejects an issuer mismatch', async () => {
    const token = await mint({ key: rsPriv, alg: 'RS256', iss: 'https://evil.test/', sub: 'agent:ryo' });
    await expectDeny(verifier().verify(token), 'issuer_mismatch');
  });

  it('rejects an audience mismatch', async () => {
    const token = await mint({ key: rsPriv, alg: 'RS256', aud: 'some-other-service', sub: 'agent:ryo' });
    await expectDeny(verifier().verify(token), 'audience_mismatch');
  });

  it('rejects a token with no subject', async () => {
    const token = await mint({ key: rsPriv, alg: 'RS256', sub: undefined });
    await expectDeny(verifier().verify(token), 'missing_subject');
  });

  it('rejects insufficient scope when requiredScopes is set', async () => {
    const token = await mint({ key: rsPriv, alg: 'RS256', sub: 'agent:ryo', scope: 'docker' });
    await expectDeny(verifier({ requiredScopes: ['credential.request'] }).verify(token), 'insufficient_scope');
  });

  it('rejects an empty/non-string token', async () => {
    await expectDeny(verifier().verify(''), 'missing_token');
    // @ts-expect-error — exercise the runtime guard
    await expectDeny(verifier().verify(undefined), 'missing_token');
  });
});

describe('JwksTokenVerifier — scope parsing', () => {
  it('parses space-delimited scope and array scopes', async () => {
    const v = verifier();
    const spaceTok = await mint({ key: rsPriv, alg: 'RS256', sub: 'a', scope: 'a  b   c' });
    expect((await v.verify(spaceTok)).scopes).toEqual(['a', 'b', 'c']);
    const arrTok = await new SignJWT({ scopes: ['x', 'y'] })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt().setIssuer(ISS).setAudience(AUD).setSubject('a').setExpirationTime('2h')
      .sign(rsPriv);
    expect((await v.verify(arrTok)).scopes).toEqual(['x', 'y']);
  });
});
