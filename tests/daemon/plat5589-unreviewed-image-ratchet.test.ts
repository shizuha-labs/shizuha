import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetConvergenceStateForTest,
  harnessReport,
  noteConvergedAgentRuntimeImage,
  noteDominantAgentRuntimeImage,
  reviewedRuntimeReleaseAdmission,
} from '../../src/daemon/harness-versions.js';

/**
 * PLAT-5589 — the fleet's desired runtime image was derived from a majority
 * vote of the fleet itself.
 *
 * Observed loop, every hop live on 2026-08-11:
 *   1. Hive writes each agent Deployment's image (`shizuha.io/runtime-owner:
 *      hive`) from `DaemonRegistry.agent_runtime_image`;
 *   2. that row is `harnessReport().agent_runtime_image`, which the daemon
 *      fills from the DOMINANT running image whenever the fleet is not
 *      converged;
 *   3. so a never-reviewed image (`…:harness-202608111151-a640e30`, 55/59
 *      seats) was desired because it was dominant, and dominant because it was
 *      desired — while the reviewed document's generation 2 could not take it
 *      back.
 *
 * The branch that ratifies the majority runs EXACTLY when the fleet has
 * diverged, so a single pass cannot catch the ratchet: pass 1 records the
 * image and every later pass then agrees with itself. These fixtures run the
 * production caller order across >= 2 consecutive reconcile passes, including
 * the daemon-restart reload boundary that re-reads the persisted state.
 */

const REVIEWED_TAG_G1 = 'localhost:30500/shizuha-agent-runtime:harness-202607121957';
const REVIEWED_DIGEST_G1 = 'sha256:09986c80d030abffcf4512fe0a2470f334cad08e53897a0a7444299715d6e0ee';
const REVIEWED_TAG_G2 = 'localhost:30500/shizuha-agent-runtime:harness-202608091406-5dd7fbf';
const REVIEWED_DIGEST_G2 = 'sha256:c9a04f980b1584aff66b9274300ddf4500a9242650663cc995d2893072b33417';
/** Never present in any reviewed generation — the image the live fleet ran. */
const UNREVIEWED_TAG = 'localhost:30500/shizuha-agent-runtime:harness-202608111151-a640e30';

const REVIEWED_DOCUMENT = {
  schema_version: 1,
  desired_generation: 2,
  releases: [
    {
      generation: 1,
      image_digest: REVIEWED_DIGEST_G1,
      display_tag: REVIEWED_TAG_G1,
      source_commit: 'ff4ca7db866e9b735cea754e1dcf3412a4d0fb8b',
      intent: 'promote',
      rollback_of_generation: null,
      approved_at: '2026-07-12T20:58:15Z',
    },
    {
      generation: 2,
      image_digest: REVIEWED_DIGEST_G2,
      display_tag: REVIEWED_TAG_G2,
      source_commit: '5dd7fbf8cb9ba84f5619c3eec2f1e6da38a8ed44',
      intent: 'promote',
      rollback_of_generation: null,
      approved_at: '2026-08-09T14:06:00Z',
    },
  ],
};

let dir: string;
let releasePath: string;
let statePath: string;
const previous: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in previous)) previous[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** One reconcile tick's report hop: the roller votes, then the report is read
 * exactly as `/v1/harness` (and therefore Hive's DaemonRegistry row) reads it. */
function reconcilePass(
  deployments: Array<{ currentImage: string; replicas?: number; readyReplicas?: number }>,
): string | null {
  noteDominantAgentRuntimeImage(
    deployments.map((d) => ({ replicas: 1, readyReplicas: 1, ...d })),
  );
  return harnessReport().agent_runtime_image;
}

/** The daemon process restarts; module memory is gone but the persisted
 * convergence file survives. This is the boundary a helper-only test skips. */
function restartDaemon(): void {
  __resetConvergenceStateForTest();
}

function persistedImage(): string | null {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8')).agent_runtime_image ?? null;
}

/** The live fleet on 2026-08-11: 55 seats on the unreviewed image, 3 on an
 * older unreviewed build, 1 (banto) actually on reviewed generation 2. */
function divergedFleet(): Array<{ currentImage: string }> {
  return [
    ...Array.from({ length: 55 }, () => ({ currentImage: UNREVIEWED_TAG })),
    ...Array.from({ length: 3 }, () => ({
      currentImage: 'localhost:30500/shizuha-agent-runtime:harness-202608102325',
    })),
    { currentImage: REVIEWED_TAG_G2 },
  ];
}

describe('PLAT-5589 unreviewed-image ratchet', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat5589-'));
    releasePath = path.join(dir, 'desired.json');
    statePath = path.join(dir, 'harness-convergence.json');
    fs.writeFileSync(releasePath, `${JSON.stringify(REVIEWED_DOCUMENT)}\n`);
    setEnv('SHIZUHA_DESIRED_RUNTIME_RELEASE_PATH', releasePath);
    setEnv('SHIZUHA_HARNESS_CONVERGENCE_STATE_FILE', statePath);
    setEnv('SHIZUHA_AGENT_RUNTIME_IMAGE', undefined);
    setEnv('FLEET_AGENT_IMAGE', undefined);
    setEnv('NODE_ENV', 'test');
    __resetConvergenceStateForTest();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      delete previous[name];
    }
    __resetConvergenceStateForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never elects an unreviewed majority, on either of two consecutive passes', () => {
    // The roller last proved reviewed generation 2.
    noteConvergedAgentRuntimeImage(REVIEWED_TAG_G2);

    const first = reconcilePass(divergedFleet());
    const second = reconcilePass(divergedFleet());

    expect(first).toBe(REVIEWED_TAG_G2);
    // Pass 1 alone cannot catch the ratchet: once the majority is recorded,
    // every later pass agrees with it. Pass 2 is the load-bearing assertion.
    expect(second).toBe(REVIEWED_TAG_G2);
    expect(persistedImage()).toBe(REVIEWED_TAG_G2);
  });

  it('does not launder the unreviewed image through a daemon restart', () => {
    noteConvergedAgentRuntimeImage(REVIEWED_TAG_G2);
    reconcilePass(divergedFleet());

    restartDaemon();
    expect(harnessReport().agent_runtime_image).toBe(REVIEWED_TAG_G2);

    // Post-restart passes re-read persisted state; the refusal must survive
    // the reload, not be re-decided from a now-empty module memory.
    expect(reconcilePass(divergedFleet())).toBe(REVIEWED_TAG_G2);
    expect(persistedImage()).toBe(REVIEWED_TAG_G2);
  });

  it('reports nothing rather than an unreviewed image when no baseline was ever proven', () => {
    // Cold daemon, no persisted proof, fleet already fully drifted. Refusing
    // leaves the field null; it must never be back-filled by the vote.
    expect(reconcilePass(divergedFleet())).toBeNull();
    expect(reconcilePass(divergedFleet())).toBeNull();
    expect(persistedImage()).toBeNull();
  });

  it('still tracks a partially rolled REVIEWED generation (2026-08-06 forever-rolling fix intact)', () => {
    noteConvergedAgentRuntimeImage(REVIEWED_TAG_G1);
    const midRoll = [
      ...Array.from({ length: 3 }, () => ({ currentImage: REVIEWED_TAG_G2 })),
      { currentImage: REVIEWED_TAG_G1 },
    ];

    expect(reconcilePass(midRoll)).toBe(REVIEWED_TAG_G2);
    expect(reconcilePass(midRoll)).toBe(REVIEWED_TAG_G2);
  });

  it('admits the digest spelling the roller actually applies', () => {
    const canonical = `localhost:30500/shizuha-agent-runtime@${REVIEWED_DIGEST_G2}`;
    const admission = reviewedRuntimeReleaseAdmission();

    expect(admission.mode).toBe('reviewed');
    expect(reconcilePass([{ currentImage: canonical }])).toBe(canonical);
  });

  it('falls back to the legacy vote only when the document is ABSENT', () => {
    fs.rmSync(releasePath);
    expect(reviewedRuntimeReleaseAdmission().mode).toBe('unreviewed');
    expect(reconcilePass(divergedFleet())).toBe(UNREVIEWED_TAG);
  });

  it('fails closed when the document exists but cannot be read', () => {
    // Present-but-unusable authority is disagreement, not permission — the
    // same reading as validateRuntimeReleaseProjections. A transient parse
    // failure must not re-open the ratchet for even one tick.
    noteConvergedAgentRuntimeImage(REVIEWED_TAG_G2);
    fs.writeFileSync(releasePath, '{ this is not json');

    expect(reviewedRuntimeReleaseAdmission().mode).toBe('unreadable');
    expect(reconcilePass(divergedFleet())).toBe(REVIEWED_TAG_G2);
    expect(reconcilePass(divergedFleet())).toBe(REVIEWED_TAG_G2);

    // A document that parses but violates the append-only invariant is equally
    // unusable, and equally must not admit the majority.
    fs.writeFileSync(releasePath, JSON.stringify({
      ...REVIEWED_DOCUMENT,
      releases: [REVIEWED_DOCUMENT.releases[1], REVIEWED_DOCUMENT.releases[0]],
    }));
    expect(reviewedRuntimeReleaseAdmission().mode).toBe('unreadable');
    expect(reconcilePass(divergedFleet())).toBe(REVIEWED_TAG_G2);
  });

  it('keeps a refused tick from mutating persisted convergence state', () => {
    noteConvergedAgentRuntimeImage(REVIEWED_TAG_G2);
    const before = fs.readFileSync(statePath, 'utf8');

    reconcilePass(divergedFleet());
    reconcilePass(divergedFleet());

    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
  });
});

/** Resolved from THIS file, never from `process.cwd()` — the dev clone is the
 * one environment where a cwd-relative path cannot fail, and CI checks the repo
 * out somewhere else entirely. */
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'daemon');

/** Slice one function body out of a source file by its own start/end anchors.
 * The end anchor is searched FROM the start offset: `pendingHarnessRollAgentIds`
 * is declared ABOVE `reconcileHarnessImageRoll`, so a whole-file `indexOf` for a
 * neighbouring symbol can return an offset BEFORE the start and yield an empty
 * slice that passes nothing and reports no error. */
function sliceBetween(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  expect(start, `start anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `end anchor not found after start: ${endAnchor}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('PLAT-5589 quarantine census (vacuous-green companion)', () => {
  it('surfaces quarantined seats so cleared deferral series cannot read as converged', () => {
    const managerSource = fs.readFileSync(path.join(SRC_DIR, 'manager.ts'), 'utf-8');
    const rollBody = sliceBetween(
      managerSource,
      'async function reconcileHarnessImageRoll(',
      'async function reconcileRuntimeLifecycle(',
    );
    // The slice itself is an instrument: prove it captured a real body before
    // reading any absence out of it.
    expect(rollBody.length).toBeGreaterThan(2000);

    // `allDrift` drops quarantined/abort plans BEFORE deferral keys are
    // computed, so "all deferral series clear" is satisfied by the failure.
    expect(rollBody).toContain("if (!plan || plan.action === 'quarantined' || plan.action === 'abort') return false;");
    // The census is what makes convergence checkable as
    // (deferrals clear AND quarantined == 0).
    expect(rollBody).toContain('quarantine census:');
    expect(rollBody).toContain('const quarantinedAgentIds = [...plans.entries()]');
    const censusAt = rollBody.indexOf('const quarantinedAgentIds = [...plans.entries()]');
    const deferralAt = rollBody.indexOf('const activeDeferralKeys = new Set(');
    expect(deferralAt).toBeGreaterThanOrEqual(0);
    expect(censusAt).toBeLessThan(deferralAt);
  });

  it('keeps the dominant-vote hop gated in the non-converged branch', () => {
    const managerSource = fs.readFileSync(path.join(SRC_DIR, 'manager.ts'), 'utf-8');
    const harnessSource = fs.readFileSync(path.join(SRC_DIR, 'harness-versions.ts'), 'utf-8');

    // The reconciler still routes the non-converged branch through the vote —
    // the gate lives inside it, so no caller can bypass it by construction.
    expect(managerSource).toContain('noteDominantAgentRuntimeImage(deploymentStates);');
    expect(harnessSource).toContain('const admission = reviewedRuntimeReleaseAdmission();');
    const gateAt = harnessSource.indexOf('const admission = reviewedRuntimeReleaseAdmission();');
    const electAt = harnessSource.indexOf('  _lastRefusedDominantImage = null;\n  noteConvergedAgentRuntimeImage(dominant);');
    expect(electAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(electAt);
  });
});
