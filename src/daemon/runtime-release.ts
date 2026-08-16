/**
 * SCLI-331: authoritative agent-runtime release contract.
 *
 * The reviewed release document is the source of truth.  The rt-fleet
 * Deployment environment and Hive/registry response are projections which
 * must agree with it before the roller may touch an agent.  The document keeps
 * monotonic history so a rollback is an explicit *new* generation rather than
 * an inferred move to an older tag.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

export const RUNTIME_RELEASE_SCHEMA_VERSION = 1;
export const RUNTIME_RELEASE_GENERATION_ANNOTATION = 'shizuha.io/runtime-release-generation';
export const RUNTIME_RELEASE_DIGEST_ANNOTATION = 'shizuha.io/runtime-release-digest';

export type RuntimeReleaseIntent = 'promote' | 'rollback';

export interface DesiredRuntimeRelease {
  generation: number;
  image_digest: string;
  /** Full display reference, for example registry/repo:harness-202607121957. */
  display_tag: string;
  source_commit: string;
  intent: RuntimeReleaseIntent;
  rollback_of_generation: number | null;
  approved_at: string;
  /** One-generation migration ledger for pre-DesiredRuntimeRelease
   * Deployments. Each entry is an immutable digest observed and reviewed when
   * this generation is approved. It authorizes only an atomic move to this
   * release (promotion or rollback); it does not make the legacy image a
   * desired or reportable release. */
  adopt_from_digests?: string[];
}

export interface DesiredRuntimeReleaseDocument {
  schema_version: number;
  desired_generation: number;
  releases: DesiredRuntimeRelease[];
}

export interface RuntimeReleaseProjection {
  generation: number;
  image_digest: string;
  display_tag: string;
}

export interface AppliedRuntimeRelease {
  generation?: number;
  imageDigest?: string;
  currentImage?: string;
  /** Resolved immutable digest for currentImage.  Required only while adopting
   * an unannotated pre-DesiredRuntimeRelease Deployment. */
  currentImageDigest?: string;
}

export type RuntimeReleasePlan =
  | { action: 'converged' }
  | { action: 'roll'; image: string; generation: number; imageDigest: string; reason: 'advance' | 'repair' | 'adopt' | 'legacy-adopt' }
  | { action: 'quarantined'; reason: string }
  | { action: 'abort'; reason: string };

export interface RuntimeReleaseAuthoritySnapshot {
  release?: DesiredRuntimeRelease;
  documentFingerprint?: string;
  issues?: string[];
}

export type RuntimeReleaseBoundaryResult =
  | { action: 'mutated'; plan: Extract<RuntimeReleasePlan, { action: 'roll' }> }
  | { action: 'converged' }
  | { action: 'invalidated'; reason: string }
  | { action: 'rejected'; reason: string };

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

function assertRecordShape(record: DesiredRuntimeRelease): void {
  if (!Number.isSafeInteger(record.generation) || record.generation <= 0) {
    throw new Error(`runtime release generation must be a positive integer (got ${record.generation})`);
  }
  if (!DIGEST_RE.test(record.image_digest)) {
    throw new Error(`runtime release ${record.generation} has invalid immutable digest`);
  }
  if (!record.display_tag.includes('shizuha-agent-runtime') || record.display_tag.includes('@')) {
    throw new Error(`runtime release ${record.generation} display_tag must be a tagged shizuha-agent-runtime image`);
  }
  const slash = record.display_tag.lastIndexOf('/');
  if (record.display_tag.lastIndexOf(':') <= slash) {
    throw new Error(`runtime release ${record.generation} display_tag must include an explicit tag`);
  }
  if (!COMMIT_RE.test(record.source_commit)) {
    throw new Error(`runtime release ${record.generation} source_commit must be a full commit SHA`);
  }
  if (record.intent !== 'promote' && record.intent !== 'rollback') {
    throw new Error(`runtime release ${record.generation} has invalid intent`);
  }
  if (!record.approved_at || Number.isNaN(Date.parse(record.approved_at))) {
    throw new Error(`runtime release ${record.generation} approved_at must be an ISO timestamp`);
  }
  if (record.adopt_from_digests !== undefined) {
    if (!Array.isArray(record.adopt_from_digests) || record.adopt_from_digests.length === 0) {
      throw new Error(`runtime release ${record.generation} adopt_from_digests must be a non-empty array`);
    }
    const unique = new Set(record.adopt_from_digests);
    if (unique.size !== record.adopt_from_digests.length) {
      throw new Error(`runtime release ${record.generation} adopt_from_digests contains duplicates`);
    }
    for (const digest of record.adopt_from_digests) {
      if (!DIGEST_RE.test(digest)) {
        throw new Error(`runtime release ${record.generation} has invalid legacy adoption digest`);
      }
      if (digest === record.image_digest) {
        throw new Error(`runtime release ${record.generation} legacy adoption ledger redundantly contains its target digest`);
      }
    }
    const canonical = [...record.adopt_from_digests].sort();
    if (record.adopt_from_digests.some((digest, index) => digest !== canonical[index])) {
      throw new Error(`runtime release ${record.generation} adopt_from_digests must be canonically sorted`);
    }
  }
}

export function parseDesiredRuntimeReleaseDocument(raw: unknown): DesiredRuntimeReleaseDocument {
  if (!raw || typeof raw !== 'object') throw new Error('runtime release document must be an object');
  const doc = raw as DesiredRuntimeReleaseDocument;
  if (doc.schema_version !== RUNTIME_RELEASE_SCHEMA_VERSION) {
    throw new Error(`unsupported runtime release schema_version ${String(doc.schema_version)}`);
  }
  if (!Array.isArray(doc.releases) || doc.releases.length === 0) {
    throw new Error('runtime release document must contain release history');
  }
  const releases = doc.releases.map((release) => ({ ...release }));
  releases.forEach(assertRecordShape);
  for (let i = 1; i < releases.length; i++) {
    if (releases[i]!.generation <= releases[i - 1]!.generation) {
      throw new Error('runtime release history must be append-only with strictly increasing generations');
    }
  }
  const highest = releases[releases.length - 1]!;
  if (doc.desired_generation !== highest.generation) {
    throw new Error(`desired_generation must select the highest reviewed generation (${highest.generation})`);
  }
  const byGeneration = new Map(releases.map((release) => [release.generation, release]));
  for (const release of releases) {
    if (release.intent === 'promote') {
      if (release.rollback_of_generation != null) {
        throw new Error(`promotion generation ${release.generation} cannot name rollback_of_generation`);
      }
      const earlierDigest = releases.find(
        (candidate) => candidate.generation < release.generation && candidate.image_digest === release.image_digest,
      );
      if (earlierDigest) {
        throw new Error(
          `promotion generation ${release.generation} reuses generation ${earlierDigest.generation} digest; ` +
          'a prior digest requires explicit rollback intent and lineage',
        );
      }
      continue;
    }
    const priorGeneration = release.rollback_of_generation;
    if (!Number.isSafeInteger(priorGeneration) || priorGeneration! >= release.generation) {
      throw new Error(`rollback generation ${release.generation} must name an earlier generation`);
    }
    const prior = byGeneration.get(priorGeneration!);
    if (!prior || prior.image_digest !== release.image_digest) {
      throw new Error(`rollback generation ${release.generation} must reuse the named prior generation digest`);
    }
  }
  return { schema_version: doc.schema_version, desired_generation: doc.desired_generation, releases };
}

export function loadDesiredRuntimeReleaseDocument(filename: string): DesiredRuntimeReleaseDocument {
  return parseDesiredRuntimeReleaseDocument(JSON.parse(fs.readFileSync(filename, 'utf-8')));
}

export function desiredRuntimeRelease(doc: DesiredRuntimeReleaseDocument): DesiredRuntimeRelease {
  const release = doc.releases.find((candidate) => candidate.generation === doc.desired_generation);
  if (!release) throw new Error(`desired runtime release generation ${doc.desired_generation} is absent`);
  return release;
}

/** Fingerprint the entire validated history, not only the selected release.
 * This makes an illicit edit to an earlier generation invalidate an in-flight
 * candidate even when the selected generation itself is unchanged. */
export function runtimeReleaseDocumentFingerprint(doc: DesiredRuntimeReleaseDocument): string {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex');
}

export function canonicalRuntimeImage(
  release: Pick<DesiredRuntimeRelease, 'display_tag' | 'image_digest'>,
): string {
  const slash = release.display_tag.lastIndexOf('/');
  const colon = release.display_tag.lastIndexOf(':');
  const repository = colon > slash ? release.display_tag.slice(0, colon) : release.display_tag;
  return `${repository}@${release.image_digest}`;
}

export function sameRuntimeRelease(a: DesiredRuntimeRelease, b: DesiredRuntimeRelease): boolean {
  return a.generation === b.generation
    && a.image_digest === b.image_digest
    && a.display_tag === b.display_tag
    && a.source_commit === b.source_commit
    && a.intent === b.intent
    && a.rollback_of_generation === b.rollback_of_generation
    && a.approved_at === b.approved_at
    && JSON.stringify(a.adopt_from_digests ?? []) === JSON.stringify(b.adopt_from_digests ?? []);
}

/** Every projection is fail-closed and complete.  Missing authority fields are
 * disagreement, not a legacy compatibility path. */
export function validateRuntimeReleaseProjections(
  release: DesiredRuntimeRelease,
  deployment: RuntimeReleaseProjection,
  registry: RuntimeReleaseProjection,
): string[] {
  const issues: string[] = [];
  const check = (name: string, projection: RuntimeReleaseProjection): void => {
    if (!Number.isSafeInteger(projection.generation) || projection.generation <= 0) {
      issues.push(`${name} omitted a valid generation`);
    } else if (projection.generation !== release.generation) {
      issues.push(`${name} generation ${projection.generation} != desired ${release.generation}`);
    }
    if (projection.display_tag !== release.display_tag) {
      issues.push(`${name} display tag ${projection.display_tag || '<empty>'} != desired ${release.display_tag}`);
    }
    if (projection.image_digest !== release.image_digest) {
      issues.push(`${name} digest ${projection.image_digest || '<empty>'} != desired ${release.image_digest}`);
    }
  };
  check('deployment projection', deployment);
  check('registry projection', registry);
  return issues;
}

export function planRuntimeRelease(
  release: DesiredRuntimeRelease,
  applied: AppliedRuntimeRelease,
): RuntimeReleasePlan {
  const image = canonicalRuntimeImage(release);
  const hasGeneration = applied.generation != null;
  const hasDigest = Boolean(applied.imageDigest);
  if (hasGeneration !== hasDigest) {
    return { action: 'abort', reason: 'applied release authority is incomplete (generation/digest must appear together)' };
  }
  if (!hasGeneration && !hasDigest) {
    if (!applied.currentImageDigest) {
      return { action: 'quarantined', reason: 'unannotated deployment has unknown immutable image digest' };
    }
    const exactTarget = applied.currentImageDigest === release.image_digest;
    const reviewedLegacy = release.adopt_from_digests?.includes(applied.currentImageDigest) ?? false;
    if (!exactTarget && !reviewedLegacy) {
      return {
        action: 'quarantined',
        reason: `unannotated deployment digest ${applied.currentImageDigest} is absent from reviewed release ${release.generation} adoption authority`,
      };
    }
    return {
      action: 'roll',
      image,
      generation: release.generation,
      imageDigest: release.image_digest,
      reason: exactTarget ? 'adopt' : 'legacy-adopt',
    };
  }
  const appliedGeneration = applied.generation!;
  const appliedDigest = applied.imageDigest!;
  if (appliedGeneration > release.generation) {
    return { action: 'abort', reason: `applied generation ${appliedGeneration} is newer than desired ${release.generation}` };
  }
  if (appliedGeneration === release.generation && appliedDigest && appliedDigest !== release.image_digest) {
    return { action: 'abort', reason: 'equal generation carries a different digest' };
  }
  if (appliedGeneration === release.generation && appliedDigest === release.image_digest) {
    return applied.currentImage === image
      ? { action: 'converged' }
      : { action: 'roll', image, generation: release.generation, imageDigest: release.image_digest, reason: 'repair' };
  }
  return { action: 'roll', image, generation: release.generation, imageDigest: release.image_digest, reason: 'advance' };
}

/** Execute the last, interruption-safe mutation boundary.
 *
 * The caller performs fleet-wide preflight and idle selection first. This
 * boundary then re-reads the target, re-reads the complete release authority
 * after that target read, and finally delegates to a server-side CAS mutator.
 * A TERM/error leaves applied state untouched; the next reconcile repeats the
 * same reads and either converges or attempts the same generation again.
 */
export async function executeRuntimeReleaseMutationBoundary<T extends AppliedRuntimeRelease>(
  candidate: DesiredRuntimeRelease,
  candidateFingerprint: string,
  hooks: {
    readApplied: () => Promise<T | null> | T | null;
    resolveUnannotatedDigest: (applied: T) => Promise<string | undefined>;
    readAuthority: () => Promise<RuntimeReleaseAuthoritySnapshot>;
    mutate: (applied: T, release: DesiredRuntimeRelease) => Promise<void> | void;
  },
): Promise<RuntimeReleaseBoundaryResult> {
  const applied = await hooks.readApplied();
  if (!applied) return { action: 'rejected', reason: 'target Deployment unavailable at mutation boundary' };
  const currentImageDigest = applied.generation == null && !applied.imageDigest
    ? await hooks.resolveUnannotatedDigest(applied)
    : undefined;
  const plan = planRuntimeRelease(candidate, {
    ...applied,
    ...(currentImageDigest ? { currentImageDigest } : {}),
  });
  if (plan.action === 'abort' || plan.action === 'quarantined') {
    return { action: 'rejected', reason: plan.reason };
  }
  if (plan.action === 'converged') return { action: 'converged' };

  // This is deliberately AFTER the target GET and immediately before the
  // conditional write: history/projection drift in the idle/CAS window must
  // prevent even the first partial roll.
  const authority = await hooks.readAuthority();
  if (
    !authority.release
    || !sameRuntimeRelease(candidate, authority.release)
    || authority.documentFingerprint !== candidateFingerprint
  ) {
    return {
      action: 'invalidated',
      reason: authority.issues?.join('; ') || 'release history/projection changed at mutation boundary',
    };
  }
  try {
    await hooks.mutate(applied, candidate);
    return { action: 'mutated', plan };
  } catch (err) {
    return { action: 'rejected', reason: err instanceof Error ? err.message : String(err) };
  }
}
