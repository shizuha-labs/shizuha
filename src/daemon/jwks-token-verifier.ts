// PLAT-166 / ADR-PLAT-002 §5.2 — JWKS-based token verifier for the credential
// broker's cluster-internal network listener.
//
// Verifies agent JWTs minted by shizuha-id (RS256/EdDSA, PLAT-255 RS256-terminal)
// against the issuer's published JWKS. This is a TRANSPORT-AUTHN component only:
// it authenticates the caller (validated `sub`) and surfaces scopes; it adds NO
// authorization — the unchanged credential-broker arbiter remains the sole grant
// authority (see credential-broker.ts). Deny-by-default throughout.
//
// Security invariants (akira review surface):
//   - Asymmetric algs ONLY. `none` and ALL `HS*` are rejected — both at config
//     time (cannot even be installed) and at verify time (alg-confusion defense:
//     an HS* token would otherwise be HMAC-verified using the RSA/Ed PUBLIC key
//     as the shared secret).
//   - iss, aud, exp validated (via jose, with a small clock tolerance).
//   - A non-empty string `sub` is required.
//   - Unknown signing key (kid miss) → reject (jose: no matching key).

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/** Algorithms the broker will EVER accept. Asymmetric only — never HS* or none. */
export const ALLOWED_ALGS = ['RS256', 'EdDSA'] as const;
export type AllowedAlg = (typeof ALLOWED_ALGS)[number];

function isAllowedAlg(alg: string): alg is AllowedAlg {
  return (ALLOWED_ALGS as readonly string[]).includes(alg);
}

/** Stable, non-secret-bearing failure codes for fail-closed audit. */
export type TokenVerificationCode =
  | 'missing_token'
  | 'alg_not_allowed'
  | 'bad_signature'
  | 'kid_not_found'
  | 'expired'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'claim_invalid'
  | 'missing_subject'
  | 'insufficient_scope'
  | 'verification_failed';

export class TokenVerificationError extends Error {
  readonly code: TokenVerificationCode;
  constructor(code: TokenVerificationCode, message: string) {
    super(message);
    this.name = 'TokenVerificationError';
    this.code = code;
  }
}

export interface VerifiedToken {
  /** Validated `sub` — the broker resolves this to an AgentInfo (no new authz). */
  subject: string;
  /** Parsed scopes (space-delimited `scope` or array `scopes`); [] if absent. */
  scopes: string[];
  /** The verified algorithm (always within ALLOWED_ALGS). */
  alg: string;
  /** Full validated payload (metadata-only logging at the call site). */
  payload: JWTPayload;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export interface JwksTokenVerifierConfig {
  /** shizuha-id JWKS URL (e.g. https://…/.well-known/jwks.json). Prod path. */
  jwksUri?: string;
  /**
   * Pre-built JWKS key-getter (DI / tests). Exactly one of jwksUri | jwks must
   * be set. In prod use jwksUri (remote set with kid-rotation cache); tests
   * inject a local set.
   */
  jwks?: JWTVerifyGetKey;
  /** Expected `iss`. */
  issuer: string;
  /** Expected `aud` (the broker's audience identifier). */
  audience: string;
  /** Allowlist subset of ALLOWED_ALGS; defaults to all of them. */
  algorithms?: string[];
  /** If set, the token's scopes must include every entry. */
  requiredScopes?: string[];
  /** Clock skew tolerance for exp/nbf, seconds (default 5). */
  clockToleranceSec?: number;
}

export class JwksTokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly algorithms: string[];
  private readonly issuer: string;
  private readonly audience: string;
  private readonly requiredScopes: string[];
  private readonly clockToleranceSec: number;

  constructor(cfg: JwksTokenVerifierConfig) {
    const algorithms = cfg.algorithms ?? [...ALLOWED_ALGS];
    if (algorithms.length === 0) {
      throw new Error('JwksTokenVerifier: algorithm allowlist must not be empty');
    }
    for (const alg of algorithms) {
      if (!isAllowedAlg(alg)) {
        throw new Error(
          `JwksTokenVerifier: refusing disallowed algorithm "${alg}" — only ${ALLOWED_ALGS.join(
            '/',
          )} permitted (never HS*/none; alg-confusion guard)`,
        );
      }
    }
    if (!cfg.issuer || !cfg.audience) {
      throw new Error('JwksTokenVerifier: issuer and audience are required');
    }
    if ((cfg.jwksUri == null) === (cfg.jwks == null)) {
      throw new Error('JwksTokenVerifier: provide exactly one of jwksUri or jwks');
    }

    this.algorithms = algorithms;
    this.issuer = cfg.issuer;
    this.audience = cfg.audience;
    this.requiredScopes = cfg.requiredScopes ?? [];
    this.clockToleranceSec = cfg.clockToleranceSec ?? 5;
    this.jwks =
      cfg.jwks ??
      // Remote set: handles kid selection + kid-rotation refetch with cooldown.
      createRemoteJWKSet(new URL(cfg.jwksUri as string), {
        cacheMaxAge: 600_000, // 10 min
        cooldownDuration: 30_000, // min spacing between refetches on kid miss
        timeoutDuration: 5_000,
      });
  }

  async verify(token: string): Promise<VerifiedToken> {
    if (!token || typeof token !== 'string') {
      throw new TokenVerificationError('missing_token', 'no bearer token presented');
    }

    let payload: JWTPayload;
    let alg: string;
    try {
      const res = await jwtVerify(token, this.jwks, {
        // jose enforces the allowlist: rejects `none`, any HS*, and any alg not
        // listed here — before signature verification.
        algorithms: this.algorithms,
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockToleranceSec,
      });
      payload = res.payload;
      alg = res.protectedHeader.alg;
    } catch (err) {
      throw mapJoseError(err);
    }

    // Defense in depth: re-assert the alg even though jose already enforced it.
    if (!isAllowedAlg(alg) || !this.algorithms.includes(alg)) {
      throw new TokenVerificationError('alg_not_allowed', `algorithm "${alg}" not allowed`);
    }

    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new TokenVerificationError('missing_subject', 'token has no usable subject (sub)');
    }

    const scopes = parseScopes(payload);
    for (const required of this.requiredScopes) {
      if (!scopes.includes(required)) {
        throw new TokenVerificationError(
          'insufficient_scope',
          `token missing required scope "${required}"`,
        );
      }
    }

    return { subject, scopes, alg, payload };
  }
}

/** Parse OAuth-style scopes: space-delimited `scope` string or `scopes` array. */
export function parseScopes(payload: JWTPayload): string[] {
  const raw = (payload as Record<string, unknown>).scope ?? (payload as Record<string, unknown>).scopes;
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return [];
}

/** Map jose's error codes to stable, non-secret-bearing verification codes. */
function mapJoseError(err: unknown): TokenVerificationError {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return new TokenVerificationError('expired', 'token has expired');
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return new TokenVerificationError('alg_not_allowed', 'token algorithm not allowed');
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return new TokenVerificationError('bad_signature', 'signature verification failed');
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return new TokenVerificationError('kid_not_found', 'no matching JWKS key for token kid');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = (err as { claim?: string }).claim;
      if (claim === 'iss') return new TokenVerificationError('issuer_mismatch', 'issuer mismatch');
      if (claim === 'aud') return new TokenVerificationError('audience_mismatch', 'audience mismatch');
      return new TokenVerificationError('claim_invalid', `claim validation failed (${claim ?? 'unknown'})`);
    }
    default:
      return new TokenVerificationError(
        'verification_failed',
        `token verification failed${code ? ` (${code})` : ''}`,
      );
  }
}
