import { describe, expect, it } from 'vitest';
import {
  canonicalRuntimeImage,
  desiredRuntimeRelease,
  executeRuntimeReleaseMutationBoundary,
  parseDesiredRuntimeReleaseDocument,
  planRuntimeRelease,
  runtimeReleaseDocumentFingerprint,
  sameRuntimeRelease,
  validateRuntimeReleaseProjections,
  type DesiredRuntimeRelease,
} from '../../src/daemon/runtime-release.js';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const D3 = `sha256:${'3'.repeat(64)}`;
const D4 = `sha256:${'4'.repeat(64)}`;

function release(overrides: Partial<DesiredRuntimeRelease> = {}): DesiredRuntimeRelease {
  return {
    generation: 2,
    image_digest: D2,
    display_tag: 'localhost:30500/shizuha-agent-runtime:harness-b',
    source_commit: 'b'.repeat(40),
    intent: 'promote',
    rollback_of_generation: null,
    approved_at: '2026-07-12T22:00:00Z',
    ...overrides,
  };
}

describe('DesiredRuntimeRelease contract (SCLI-331)', () => {
  it('accepts monotonic reviewed history and selects the highest generation', () => {
    const doc = parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 2,
      releases: [
        release({ generation: 1, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', source_commit: 'a'.repeat(40) }),
        release(),
      ],
    });
    expect(desiredRuntimeRelease(doc).generation).toBe(2);
    expect(canonicalRuntimeImage(desiredRuntimeRelease(doc))).toBe(`localhost:30500/shizuha-agent-runtime@${D2}`);
  });

  it('rejects a stale desired generation instead of inferring rollback', () => {
    expect(() => parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 1,
      releases: [
        release({ generation: 1, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', source_commit: 'a'.repeat(40) }),
        release(),
      ],
    })).toThrow(/highest reviewed generation/);
  });

  it('allows a prior digest only through a new explicit rollback generation', () => {
    const doc = parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 3,
      releases: [
        release({ generation: 1, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', source_commit: 'a'.repeat(40) }),
        release(),
        release({
          generation: 3,
          image_digest: D1,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a-rollback',
          source_commit: 'c'.repeat(40),
          intent: 'rollback',
          rollback_of_generation: 1,
        }),
      ],
    });
    expect(desiredRuntimeRelease(doc)).toMatchObject({ generation: 3, intent: 'rollback', image_digest: D1 });
  });

  it('rejects implicit rollback disguised as a promotion that reuses an earlier digest', () => {
    expect(() => parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 3,
      releases: [
        release({ generation: 1, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', source_commit: 'a'.repeat(40) }),
        release(),
        release({
          generation: 3,
          image_digest: D1,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a-again',
          source_commit: 'c'.repeat(40),
        }),
      ],
    })).toThrow(/prior digest requires explicit rollback intent/);
  });

  it('rejects reordered history instead of sorting it into apparent validity', () => {
    expect(() => parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 2,
      releases: [
        release(),
        release({ generation: 1, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', source_commit: 'a'.repeat(40) }),
      ],
    })).toThrow(/append-only with strictly increasing generations/);
  });

  it('rejects rollback lineage whose digest does not match the named generation', () => {
    expect(() => parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 3,
      releases: [
        release({ generation: 1, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', source_commit: 'a'.repeat(40) }),
        release(),
        release({ generation: 3, source_commit: 'c'.repeat(40), intent: 'rollback', rollback_of_generation: 1 }),
      ],
    })).toThrow(/reuse the named prior generation digest/);
  });

  it.each([
    ['stale registry vs newer record', { generation: 1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', image_digest: D1 }],
    ['registry-newer vs record', { generation: 3, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-c', image_digest: `sha256:${'3'.repeat(64)}` }],
    ['tag/digest mismatch', { generation: 2, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-b', image_digest: D1 }],
  ])('fails closed on %s', (_name, registry) => {
    const desired = release();
    expect(validateRuntimeReleaseProjections(
      desired,
      { generation: 2, display_tag: desired.display_tag, image_digest: desired.image_digest },
      registry,
    )).not.toEqual([]);
  });

  it.each([
    ['deployment', { display_tag: 'localhost:30500/shizuha-agent-runtime:harness-b', image_digest: D2 }],
    ['registry', { display_tag: 'localhost:30500/shizuha-agent-runtime:harness-b', image_digest: D2 }],
  ])('fails closed when the %s projection omits generation', (which, incomplete) => {
    const desired = release();
    const complete = { generation: 2, display_tag: desired.display_tag, image_digest: desired.image_digest };
    const issues = validateRuntimeReleaseProjections(
      desired,
      (which === 'deployment' ? incomplete : complete) as any,
      (which === 'registry' ? incomplete : complete) as any,
    );
    expect(issues.join('; ')).toMatch(/omitted a valid generation/);
  });

  it('adopts an unannotated deployment only when its resolved immutable digest matches the reviewed baseline', () => {
    expect(planRuntimeRelease(release(), {
      currentImage: 'localhost:30500/shizuha-agent-runtime:harness-b',
      currentImageDigest: D2,
    })).toMatchObject({ action: 'roll', reason: 'adopt', generation: 2, imageDigest: D2 });
    expect(planRuntimeRelease(release(), {
      currentImage: 'localhost:30500/shizuha-agent-runtime:harness-unknown',
      currentImageDigest: D1,
    })).toMatchObject({ action: 'quarantined' });
    expect(planRuntimeRelease(release(), {
      currentImage: 'localhost:30500/shizuha-agent-runtime:harness-unknown',
    })).toMatchObject({ action: 'quarantined' });
  });

  it('migrates only explicitly reviewed legacy digests to the selected release', () => {
    const legacy = `sha256:${'4'.repeat(64)}`;
    const desired = release({ adopt_from_digests: [legacy] });
    expect(planRuntimeRelease(desired, {
      currentImage: 'localhost:30500/shizuha-agent-runtime:harness-legacy',
      currentImageDigest: legacy,
    })).toMatchObject({ action: 'roll', reason: 'legacy-adopt', generation: 2, imageDigest: D2 });
    expect(planRuntimeRelease(desired, {
      currentImage: 'localhost:30500/shizuha-agent-runtime:harness-unreviewed',
      currentImageDigest: D1,
    })).toMatchObject({ action: 'quarantined' });
  });

  it('rejects malformed, duplicate, target, and non-canonical legacy-adoption ledgers', () => {
    for (const adopt_from_digests of [[], ['not-a-digest'], [D1, D1], [D2], [D4, D3]]) {
      expect(() => parseDesiredRuntimeReleaseDocument({
        schema_version: 1,
        desired_generation: 2,
        releases: [
          release({ generation: 1, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', source_commit: 'a'.repeat(40) }),
          release({ adopt_from_digests }),
        ],
      })).toThrow();
    }
  });

  it('allows a rollback generation to carry canonically reviewed legacy adoption authority', () => {
    const parsed = parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 5,
      releases: [
        release({ generation: 3, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen3', source_commit: 'a'.repeat(40) }),
        release({ generation: 4, image_digest: D2, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen4' }),
        release({
          generation: 5,
          image_digest: D1,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen3-rollback',
          source_commit: 'c'.repeat(40),
          intent: 'rollback',
          rollback_of_generation: 3,
          adopt_from_digests: [D3, D4],
        }),
      ],
    });
    expect(desiredRuntimeRelease(parsed)).toMatchObject({
      generation: 5,
      image_digest: D1,
      intent: 'rollback',
      rollback_of_generation: 3,
      adopt_from_digests: [D3, D4],
    });
  });

  it('rejects partial applied authority instead of inferring generation zero', () => {
    expect(planRuntimeRelease(release(), { generation: 1, currentImageDigest: D2 })).toMatchObject({ action: 'abort' });
    expect(planRuntimeRelease(release(), { imageDigest: D2, currentImageDigest: D2 })).toMatchObject({ action: 'abort' });
  });

  it('plans one advance and then converges idempotently', () => {
    const desired = release();
    const plan = planRuntimeRelease(desired, {
      generation: 1,
      imageDigest: D1,
      currentImage: `localhost:30500/shizuha-agent-runtime@${D1}`,
    });
    expect(plan).toMatchObject({ action: 'roll', generation: 2, imageDigest: D2, reason: 'advance' });
    expect(planRuntimeRelease(desired, {
      generation: 2,
      imageDigest: D2,
      currentImage: canonicalRuntimeImage(desired),
    })).toEqual({ action: 'converged' });
  });

  it('rejects a candidate older than the per-agent applied generation', () => {
    expect(planRuntimeRelease(release(), {
      generation: 3,
      imageDigest: `sha256:${'3'.repeat(64)}`,
      currentImage: 'localhost:30500/shizuha-agent-runtime@sha256:' + '3'.repeat(64),
    })).toMatchObject({ action: 'abort' });
  });

  it('invalidates a candidate when a concurrent promotion changes generation or digest', () => {
    expect(sameRuntimeRelease(release(), release())).toBe(true);
    expect(sameRuntimeRelease(release(), release({ generation: 3 }))).toBe(false);
    expect(sameRuntimeRelease(release(), release({ image_digest: D1 }))).toBe(false);
    expect(sameRuntimeRelease(
      release({ adopt_from_digests: [D1] }),
      release({ adopt_from_digests: [`sha256:${'3'.repeat(64)}`] }),
    )).toBe(false);
  });

  it('fingerprints the complete immutable history so prior-generation edits invalidate a candidate', () => {
    const base = parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 2,
      releases: [
        release({ generation: 1, image_digest: D1, display_tag: 'localhost:30500/shizuha-agent-runtime:harness-a', source_commit: 'a'.repeat(40) }),
        release(),
      ],
    });
    const tampered = parseDesiredRuntimeReleaseDocument({
      ...base,
      releases: [
        { ...base.releases[0]!, approved_at: '2026-07-12T21:59:59Z' },
        base.releases[1]!,
      ],
    });
    expect(runtimeReleaseDocumentFingerprint(tampered)).not.toBe(runtimeReleaseDocumentFingerprint(base));
  });

  it('repairs image drift at equal generation without accepting a different digest', () => {
    expect(planRuntimeRelease(release(), {
      generation: 2,
      imageDigest: D2,
      currentImage: 'localhost:30500/shizuha-agent-runtime:harness-stale',
    })).toMatchObject({ action: 'roll', reason: 'repair' });
    expect(planRuntimeRelease(release(), {
      generation: 2,
      imageDigest: D1,
      currentImage: 'localhost:30500/shizuha-agent-runtime:harness-stale',
    })).toMatchObject({ action: 'abort' });
  });

  it('re-reads full authority after target state and blocks last-boundary projection drift', async () => {
    const desired = release();
    let mutations = 0;
    const result = await executeRuntimeReleaseMutationBoundary(desired, 'fingerprint-a', {
      readApplied: () => ({ generation: 1, imageDigest: D1, currentImage: `repo@${D1}` }),
      resolveUnannotatedDigest: async () => undefined,
      readAuthority: async () => ({
        release: release({ generation: 3, image_digest: `sha256:${'3'.repeat(64)}` }),
        documentFingerprint: 'fingerprint-b',
      }),
      mutate: () => { mutations += 1; },
    });
    expect(result).toMatchObject({ action: 'invalidated' });
    expect(mutations).toBe(0);
  });

  it('TERM/error at the CAS boundary leaves state retryable and the next reconcile mutates once', async () => {
    const desired = release();
    const applied = { generation: 1, imageDigest: D1, currentImage: `repo@${D1}` };
    let attempts = 0;
    const hooks = {
      readApplied: () => applied,
      resolveUnannotatedDigest: async () => undefined,
      readAuthority: async () => ({ release: desired, documentFingerprint: 'stable' }),
      mutate: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('terminated before Kubernetes accepted CAS');
      },
    };
    expect(await executeRuntimeReleaseMutationBoundary(desired, 'stable', hooks)).toMatchObject({ action: 'rejected' });
    expect(await executeRuntimeReleaseMutationBoundary(desired, 'stable', hooks)).toMatchObject({ action: 'mutated' });
    expect(attempts).toBe(2);
  });

  it('repeated reconcile of converged state produces zero mutations', async () => {
    const desired = release();
    let mutations = 0;
    const hooks = {
      readApplied: () => ({
        generation: 2,
        imageDigest: D2,
        currentImage: canonicalRuntimeImage(desired),
      }),
      resolveUnannotatedDigest: async () => undefined,
      readAuthority: async () => ({ release: desired, documentFingerprint: 'stable' }),
      mutate: () => { mutations += 1; },
    };
    expect(await executeRuntimeReleaseMutationBoundary(desired, 'stable', hooks)).toEqual({ action: 'converged' });
    expect(await executeRuntimeReleaseMutationBoundary(desired, 'stable', hooks)).toEqual({ action: 'converged' });
    expect(mutations).toBe(0);
  });

  it('never mutates an unannotated non-matching baseline at the boundary', async () => {
    const desired = release();
    let mutations = 0;
    const result = await executeRuntimeReleaseMutationBoundary(desired, 'stable', {
      readApplied: () => ({ currentImage: 'legacy:tag' }),
      resolveUnannotatedDigest: async () => D1,
      readAuthority: async () => ({ release: desired, documentFingerprint: 'stable' }),
      mutate: () => { mutations += 1; },
    });
    expect(result).toMatchObject({ action: 'rejected' });
    expect(mutations).toBe(0);
  });

  it('revalidates authority and mutates exactly once for a reviewed legacy digest', async () => {
    const legacy = `sha256:${'4'.repeat(64)}`;
    const desired = release({ adopt_from_digests: [legacy] });
    let authorityReads = 0;
    let mutations = 0;
    const result = await executeRuntimeReleaseMutationBoundary(desired, 'stable-ledger', {
      readApplied: () => ({ currentImage: 'localhost:30500/shizuha-agent-runtime:harness-legacy' }),
      resolveUnannotatedDigest: async () => legacy,
      readAuthority: async () => {
        authorityReads += 1;
        return { release: desired, documentFingerprint: 'stable-ledger' };
      },
      mutate: () => { mutations += 1; },
    });
    expect(result).toMatchObject({ action: 'mutated', plan: { reason: 'legacy-adopt' } });
    expect(authorityReads).toBe(1);
    expect(mutations).toBe(1);
  });

  it('plans and executes a partial-rollout rollback without widening adoption authority', async () => {
    const document = parseDesiredRuntimeReleaseDocument({
      schema_version: 1,
      desired_generation: 5,
      releases: [
        release({
          generation: 3,
          image_digest: D1,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen3',
          source_commit: 'a'.repeat(40),
        }),
        release({
          generation: 4,
          image_digest: D2,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen4',
        }),
        release({
          generation: 5,
          image_digest: D1,
          display_tag: 'localhost:30500/shizuha-agent-runtime:harness-gen3-rollback',
          source_commit: 'c'.repeat(40),
          intent: 'rollback',
          rollback_of_generation: 3,
          adopt_from_digests: [D3, D4],
        }),
      ],
    });
    const desired = desiredRuntimeRelease(document);
    const fingerprint = runtimeReleaseDocumentFingerprint(document);

    // A seat already moved by generation 4 is normal annotated advancement to
    // the new generation 5 rollback target. Its current digest need not appear
    // in legacy adoption authority because the paired annotations are proof.
    expect(planRuntimeRelease(desired, {
      generation: 4,
      imageDigest: D2,
      currentImage: `localhost:30500/shizuha-agent-runtime@${D2}`,
    })).toMatchObject({ action: 'roll', reason: 'advance', generation: 5, imageDigest: D1 });

    // Untouched seats are admitted only by the immutable census reviewed into
    // generation 5. Exact-target legacy seats are safe adoption; a listed
    // alternate legacy digest can migrate; everything else remains quarantined.
    expect(planRuntimeRelease(desired, { currentImage: 'legacy-gen3', currentImageDigest: D1 }))
      .toMatchObject({ action: 'roll', reason: 'adopt', generation: 5, imageDigest: D1 });
    expect(planRuntimeRelease(desired, { currentImage: 'legacy-listed', currentImageDigest: D3 }))
      .toMatchObject({ action: 'roll', reason: 'legacy-adopt', generation: 5, imageDigest: D1 });
    expect(planRuntimeRelease(desired, { currentImage: 'legacy-unknown', currentImageDigest: `sha256:${'9'.repeat(64)}` }))
      .toMatchObject({ action: 'quarantined' });

    const order: string[] = [];
    let mutations = 0;
    const rollbackBoundary = await executeRuntimeReleaseMutationBoundary(desired, fingerprint, {
      readApplied: () => {
        order.push('target-read');
        return { currentImage: 'legacy-listed' };
      },
      resolveUnannotatedDigest: async () => {
        order.push('digest-resolve');
        return D3;
      },
      readAuthority: async () => {
        order.push('authority-reread');
        return { release: desired, documentFingerprint: fingerprint };
      },
      mutate: () => {
        order.push('mutation');
        mutations += 1;
      },
    });
    expect(rollbackBoundary).toMatchObject({ action: 'mutated', plan: { reason: 'legacy-adopt' } });
    expect(order).toEqual(['target-read', 'digest-resolve', 'authority-reread', 'mutation']);
    expect(mutations).toBe(1);

    // Removing the seat from the re-read authority is detected because the
    // complete candidate record (including its ledger) must remain identical.
    const narrowed = { ...desired, adopt_from_digests: [D4] };
    const invalidated = await executeRuntimeReleaseMutationBoundary(desired, fingerprint, {
      readApplied: () => ({ currentImage: 'legacy-listed' }),
      resolveUnannotatedDigest: async () => D3,
      readAuthority: async () => ({ release: narrowed, documentFingerprint: 'changed' }),
      mutate: () => { mutations += 1; },
    });
    expect(invalidated).toMatchObject({ action: 'invalidated' });
    expect(mutations).toBe(1);

    let unknownAuthorityReads = 0;
    const unknown = await executeRuntimeReleaseMutationBoundary(desired, fingerprint, {
      readApplied: () => ({ currentImage: 'legacy-unknown' }),
      resolveUnannotatedDigest: async () => `sha256:${'9'.repeat(64)}`,
      readAuthority: async () => {
        unknownAuthorityReads += 1;
        return { release: desired, documentFingerprint: fingerprint };
      },
      mutate: () => { mutations += 1; },
    });
    expect(unknown).toMatchObject({ action: 'rejected', reason: expect.stringContaining('absent from reviewed') });
    expect(unknownAuthorityReads).toBe(0);
    expect(mutations).toBe(1);
  });
});
