import { describe, expect, it } from 'vitest';
import {
  evaluateSkillStaleness,
  renderSkillStalenessNotice,
} from '../../src/shared/skill-staleness.js';

// Real revisions observed 2026-07-21: at that moment the pod, the lock and the
// skills HEAD were all `f98ddca9…` (the PLAT-5024 frontend-live-loop correction).
// Using the real converged value keeps the "current" fixtures honest.
const CONVERGED = 'f98ddca92d071b62a3a7f1a79319a107bc8954ce';
const NEWER = '0df96c7a1b2c3d4e5f60718293a4b5c6d7e8f901';
const NEWEST = '2eb1de8f0e1d2c3b4a5968778695a4b3c2d1e0f9';

describe('evaluateSkillStaleness', () => {
  it('reports converged when all three revisions agree', () => {
    const report = evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: CONVERGED, publishedRevision: CONVERGED,
    });
    expect(report.rollGap.kind).toBe('current');
    expect(report.buildGap.kind).toBe('current');
    expect(report.converged).toBe(true);
  });

  it('separates the ROLL gap from the BUILD gap', () => {
    // The pod is behind the image; the image is current. This is the
    // PLAT-5026 case — the roll queue, not the build pipeline.
    const rollOnly = evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: NEWER, publishedRevision: NEWER,
    });
    expect(rollOnly.rollGap).toEqual({ kind: 'behind', have: CONVERGED, want: NEWER });
    expect(rollOnly.buildGap.kind).toBe('current');

    // The pod matches the image; a publication has not been built yet. Same
    // agent-visible symptom, entirely different owner.
    const buildOnly = evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: CONVERGED, publishedRevision: NEWER,
    });
    expect(buildOnly.rollGap.kind).toBe('current');
    expect(buildOnly.buildGap).toEqual({ kind: 'behind', have: CONVERGED, want: NEWER });
  });

  it('reports both gaps when the pod is behind an image that is itself behind', () => {
    const report = evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: NEWER, publishedRevision: NEWEST,
    });
    expect(report.rollGap.kind).toBe('behind');
    expect(report.buildGap.kind).toBe('behind');
    expect(report.converged).toBe(false);
  });

  // ---- the fail-open cases: "could not tell" must never read as "fine" ----

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   \n'],
    ['a short prefix', 'f98ddca9'],
    ['a non-hex string', 'not-a-revision-at-all-not-a-revision-atx'],
    ['an error page', '<html>404</html>'],
  ])('reports UNKNOWN (never current) when the pod revision is %s', (_label, bad) => {
    const report = evaluateSkillStaleness({
      podRevision: bad as string | null | undefined,
      lockRevision: CONVERGED,
      publishedRevision: CONVERGED,
    });
    expect(report.rollGap.kind).toBe('unknown');
    expect(report.converged).toBe(false);
  });

  it('reports UNKNOWN for the build gap when the published revision is unavailable', () => {
    // An agent that cannot reach the forge still gets a usable rollGap.
    const report = evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: CONVERGED, publishedRevision: null,
    });
    expect(report.rollGap.kind).toBe('current');
    expect(report.buildGap.kind).toBe('unknown');
    expect(report.converged).toBe(false);
  });

  it('does NOT accept a truncated revision as matching its full form', () => {
    // A lenient prefix compare would call this converged. It must not.
    const report = evaluateSkillStaleness({
      podRevision: CONVERGED.slice(0, 12), lockRevision: CONVERGED,
    });
    expect(report.rollGap.kind).toBe('unknown');
  });

  it('normalises case and surrounding whitespace, since the file has a trailing newline', () => {
    const report = evaluateSkillStaleness({
      podRevision: `  ${CONVERGED.toUpperCase()}\n`,
      lockRevision: `${CONVERGED}\n`,
      publishedRevision: CONVERGED,
    });
    expect(report.converged).toBe(true);
  });
});

describe('renderSkillStalenessNotice', () => {
  it('renders NOTHING when converged — an up-to-date agent must see no text', () => {
    const report = evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: CONVERGED, publishedRevision: CONVERGED,
    });
    expect(renderSkillStalenessNotice(report)).toBeNull();
  });

  it('names the roll gap and both revisions when the pod is behind', () => {
    const notice = renderSkillStalenessNotice(evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: NEWER, publishedRevision: NEWER,
    }));
    expect(notice).toContain(CONVERGED.slice(0, 12));
    expect(notice).toContain(NEWER.slice(0, 12));
    expect(notice).toContain('may have been corrected');
  });

  it('says so explicitly when staleness could not be determined', () => {
    const notice = renderSkillStalenessNotice(evaluateSkillStaleness({
      podRevision: null, lockRevision: CONVERGED, publishedRevision: CONVERGED,
    }));
    expect(notice).toContain('Could not determine');
    expect(notice).toContain('unverified');
  });

  it('never implies the agent is gated, blocked or should stop', () => {
    // PLAT-5026 rejected every interrupt-shaped remedy. The notice must not
    // read as one, or it becomes the interrupt vector by wording alone.
    const notice = renderSkillStalenessNotice(evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: NEWER, publishedRevision: NEWEST,
    })) ?? '';
    expect(notice).toContain('Nothing is gating your work');
    for (const forbidden of ['blocked', 'do not proceed', 'stop work', 'halt', 'wait for']) {
      expect(notice.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('surfaces the publication count when the caller measured it', () => {
    const notice = renderSkillStalenessNotice(evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: NEWER, publishedRevision: NEWEST,
      publicationsBehind: 3,
    })) ?? '';
    expect(notice).toContain('`3` publications behind');
  });

  it('never invents a count the caller could not measure', () => {
    // No publicationsBehind supplied -> the notice still reports the gap but
    // never a number, so a reader can't mistake "unknown" for "zero behind".
    const notice = renderSkillStalenessNotice(evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: NEWER, publishedRevision: NEWEST,
    })) ?? '';
    expect(notice).not.toMatch(/publications behind/);
    expect(notice).toContain('may have been corrected');
  });

  it('flags critical among publications only when provably true', () => {
    const notice = renderSkillStalenessNotice(evaluateSkillStaleness({
      podRevision: CONVERGED, lockRevision: NEWER, publishedRevision: NEWEST,
      publicationsBehind: 2,
      criticalAmongPublications: true,
    })) ?? '';
    expect(notice).toContain('touched a skill marked `critical: true`');

    // null / false / absent must never render the critical line.
    for (const critical of [null, undefined, false]) {
      const rendered = renderSkillStalenessNotice(evaluateSkillStaleness({
        podRevision: CONVERGED, lockRevision: NEWER, publishedRevision: NEWEST,
        criticalAmongPublications: critical as boolean | null | undefined,
      })) ?? '';
      expect(rendered).not.toContain('critical');
    }
  });
});
