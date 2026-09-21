/** Self-detectable skill staleness (PLAT-5046, from the PLAT-5026 decision).
 *
 * An idle-gated roll reaches quiet agents first and busy agents last, but the
 * agents most likely to HIT a defective skill are the ones doing that kind of
 * work. For a defect that causes unnecessary work the property is
 * self-reinforcing: the wrong directive generates false investigations, which
 * makes its victims busier, which rolls them last.
 *
 * PLAT-5026 rejected every gate-side remedy — the roller is deliberately not
 * allowed to interrupt a working agent (a 2026-07-17 override that did exactly
 * that killed live turns and triggered synchronized paid heartbeats). The one
 * accepted lever is to let the agent KNOW it is stale, so it can discount its
 * own guidance instead of acting confidently on corrected-but-unreceived text.
 *
 * That is the PLAT-4944 failure: a QA seat declared 16 tasks blocked on
 * `frontend-live-loop` guidance that had already been corrected.
 *
 * This module is PURE — no I/O, no clock, no environment. The caller supplies
 * three revisions and renders whatever this returns. Report-only by
 * construction: nothing here can gate, interrupt or defer anything.
 *
 * ## Two gaps, not one
 *
 * The propagation chain is
 *   skills merge -> deploy-skills.yml -> pin runtime-skills.lock
 *                -> build-agent-runtime.yml -> controller retarget -> pod replace
 *
 * so there are two distinct places a revision can be stuck, with different
 * owners and different remedies:
 *
 *   pod  vs lock       the image built from the current lock has not reached
 *                      this pod yet            -> the ROLL queue (PLAT-5026)
 *   lock vs published  a skill publication has not been pinned/built yet
 *                      -> the BUILD pipeline
 *
 * Collapsing them into one "you are N behind" number would point every reader
 * at the roll queue, including when the roll queue is not the problem.
 */

/** A 40-hex git object id. Anything else is not a revision we can compare. */
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

export type SkillStalenessGap =
  /** Both revisions read and equal. */
  | { kind: 'current' }
  /** Both revisions read and different. */
  | { kind: 'behind'; have: string; want: string }
  /** At least one side could not be read. NEVER reported as 'current'. */
  | { kind: 'unknown'; detail: string };

export interface SkillStalenessReport {
  /** This pod vs the revision the current runtime image pins. */
  rollGap: SkillStalenessGap;
  /** The pinned revision vs the newest published skills revision. */
  buildGap: SkillStalenessGap;
  /** True iff BOTH gaps are `current`. Deliberately not "no gap is `behind`". */
  converged: boolean;
  /**
   * Number of publications between the pod's revision and the published one,
   * when the caller could count them (git history available). `null` when the
   * count is unknown — never invented. The count is what makes the notice
   * actionable ("3 publications back"), versus "different revisions".
   */
  publicationsBehind: number | null;
  /**
   * True iff at least one intervening publication touched a skill whose
   * current frontmatter marks `critical: true`. `null` when unknown. Wired to
   * the existing `critical` frontmatter bit that already drives context
   * inlining (PLAT-5026 item 3) — REPORTING only, never preemption.
   */
  criticalAmongPublications: boolean | null;
}

export interface SkillStalenessInput {
  /** `/opt/skills/.source-revision` on this pod. */
  podRevision: string | null | undefined;
  /** `runtime-skills.lock` in the dev repo — what the image should carry. */
  lockRevision: string | null | undefined;
  /**
   * Skills repo HEAD. Optional: an agent that cannot reach the forge still
   * gets a usable rollGap, and the buildGap degrades to `unknown` rather
   * than silently reading as converged.
   */
  publishedRevision?: string | null | undefined;
  /**
   * Number of publications between pod and published revision, when the
   * caller has git history to count them. `null`/absent = unknown (never
   * rendered as a number the caller did not measure).
   */
  publicationsBehind?: number | null;
  /**
   * True iff at least one intervening publication touched a `critical: true`
   * skill. `null`/absent = unknown.
   */
  criticalAmongPublications?: boolean | null;
}

function normalise(raw: string | null | undefined): { ok: true; value: string } | { ok: false; detail: string } {
  if (raw === null || raw === undefined) return { ok: false, detail: 'not available' };
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: false, detail: 'empty' };
  if (!REVISION_PATTERN.test(value)) {
    // Do NOT fall back to a prefix match or a substring compare. A malformed
    // revision is a fact about the pipeline, not an inconvenience to route
    // around, and a lenient compare would report `current` for garbage.
    return { ok: false, detail: `not a 40-hex revision: ${JSON.stringify(raw.slice(0, 64))}` };
  }
  return { ok: true, value };
}

function compare(
  haveRaw: string | null | undefined,
  wantRaw: string | null | undefined,
  haveLabel: string,
  wantLabel: string,
): SkillStalenessGap {
  const have = normalise(haveRaw);
  const want = normalise(wantRaw);
  // Unreadable on either side is `unknown`, never `current`. The whole point of
  // this module is that "I could not tell" must not render as "you are fine" —
  // that is the fail-open shape the rest of this incident family is made of.
  if (!have.ok) return { kind: 'unknown', detail: `${haveLabel} ${have.detail}` };
  if (!want.ok) return { kind: 'unknown', detail: `${wantLabel} ${want.detail}` };
  if (have.value === want.value) return { kind: 'current' };
  return { kind: 'behind', have: have.value, want: want.value };
}

export function evaluateSkillStaleness(input: SkillStalenessInput): SkillStalenessReport {
  const rollGap = compare(input.podRevision, input.lockRevision, 'pod revision', 'pinned revision');
  const buildGap = compare(input.lockRevision, input.publishedRevision, 'pinned revision', 'published revision');
  return {
    rollGap,
    buildGap,
    converged: rollGap.kind === 'current' && buildGap.kind === 'current',
    publicationsBehind: input.publicationsBehind ?? null,
    criticalAmongPublications: input.criticalAmongPublications ?? null,
  };
}

/**
 * Render the agent-facing notice, or `null` when there is nothing to say.
 *
 * `null` on the converged path is deliberate: an up-to-date agent must see no
 * text at all, so the notice keeps its signal value and costs no context on the
 * common path.
 */
export function renderSkillStalenessNotice(report: SkillStalenessReport): string | null {
  if (report.converged) return null;

  const lines: string[] = [];

  if (report.rollGap.kind === 'behind') {
    const countText =
      report.publicationsBehind !== null && report.publicationsBehind > 0
        ? ` \`${report.publicationsBehind}\` publications behind,`
        : '';
    lines.push(
      `- Your \`/opt/skills\` is${countText} at \`${report.rollGap.have.slice(0, 12)}\`; the current runtime image `
      + `pins \`${report.rollGap.want.slice(0, 12)}\`. Skill text you are reading may have been corrected.`,
    );
  } else if (report.rollGap.kind === 'unknown') {
    lines.push(`- Could not determine whether your skills are current (${report.rollGap.detail}). Treat skill text as unverified.`);
  }

  if (report.buildGap.kind === 'behind') {
    lines.push(
      `- A newer skills revision \`${report.buildGap.want.slice(0, 12)}\` is published but not yet built `
      + `into a runtime image (pinned: \`${report.buildGap.have.slice(0, 12)}\`).`,
    );
  } else if (report.buildGap.kind === 'unknown') {
    lines.push(`- Could not determine whether a newer skills revision exists (${report.buildGap.detail}).`);
  }

  if (report.criticalAmongPublications === true) {
    lines.push(
      '- At least one intervening publication touched a skill marked `critical: true`. '
      + 'Critical guidance may have changed — when in doubt, prefer the observation over the skill text.',
    );
  }

  if (!lines.length) return null;

  return [
    '## ⚠️ Your skills may be out of date',
    '',
    ...lines,
    '',
    'This is informational. Nothing is gating your work and no action is required — '
    + 'but if a skill instructs you to do something that does not match what you observe, '
    + 'prefer the observation and say so rather than assuming the skill is right.',
  ].join('\n');
}
