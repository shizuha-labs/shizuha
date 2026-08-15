import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  analyzePatterns,
  buildDigestBody,
  runReview,
  type ReviewDigest,
} from '../../src/telemetry/run-reviewer.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<{
  title: string;
  description: string;
  status: string;
  item_key: string;
}> = {}) {
  return {
    title: '[Struggle/STALL] run:abc12345 — Agent has been silent for 20 turns.',
    description: '- **Run ID**: `abc12345-def6`\n- **Agent**: test-agent\n**Diagnosis**: Agent silent for 20 turns.',
    status: 'open',
    item_key: 'SCLI-100',
    ...overrides,
  };
}

// ─── analyzePatterns ──────────────────────────────────────────────────────────

describe('analyzePatterns', () => {
  const WINDOW = 7 * 24 * 60 * 60 * 1000;

  it('returns empty digest when no bugs', () => {
    const d = analyzePatterns([], 3, WINDOW);
    expect(d.totalBugs).toBe(0);
    expect(d.buckets).toHaveLength(0);
    expect(d.systemicCount).toBe(0);
  });

  it('groups bugs by kind', () => {
    const bugs = [
      makeItem({ title: '[Struggle/STALL] run:aaa00001 — silent.' }),
      makeItem({ title: '[Struggle/STALL] run:aaa00002 — silent.' }),
      makeItem({ title: '[Struggle/THRASH] run:bbb00001 — looping.' }),
    ];
    const d = analyzePatterns(bugs, 3, WINDOW);
    expect(d.totalBugs).toBe(3);
    expect(d.buckets).toHaveLength(2);
    const stall = d.buckets.find((b) => b.kind === 'STALL')!;
    expect(stall.count).toBe(2);
    const thrash = d.buckets.find((b) => b.kind === 'THRASH')!;
    expect(thrash.count).toBe(1);
  });

  it('marks bucket as systemic when count >= threshold', () => {
    const bugs = Array.from({ length: 3 }, (_, i) =>
      makeItem({ title: `[Struggle/ERROR_DENSITY] run:${String(i).padStart(8, '0')} — errors.` }),
    );
    const d = analyzePatterns(bugs, 3, WINDOW);
    const bucket = d.buckets.find((b) => b.kind === 'ERROR_DENSITY')!;
    expect(bucket.isSystemic).toBe(true);
    expect(d.systemicCount).toBe(1);
  });

  it('does NOT mark bucket as systemic when count < threshold', () => {
    const bugs = [
      makeItem({ title: '[Struggle/LONG_RUN] run:abc00001 — long.' }),
      makeItem({ title: '[Struggle/LONG_RUN] run:abc00002 — long.' }),
    ];
    const d = analyzePatterns(bugs, 3, WINDOW);
    const bucket = d.buckets.find((b) => b.kind === 'LONG_RUN')!;
    expect(bucket.isSystemic).toBe(false);
    expect(d.systemicCount).toBe(0);
  });

  it('extracts top agents from descriptions', () => {
    const bugs = [
      makeItem({
        title: '[Struggle/STALL] run:a — silent.',
        description: '**Agent**: sara\n**Diagnosis**: silent.',
      }),
      makeItem({
        title: '[Struggle/STALL] run:b — silent.',
        description: '**Agent**: sara\n**Diagnosis**: silent again.',
      }),
      makeItem({
        title: '[Struggle/STALL] run:c — silent.',
        description: '**Agent**: kai\n**Diagnosis**: also silent.',
      }),
    ];
    const d = analyzePatterns(bugs, 3, WINDOW);
    const bucket = d.buckets.find((b) => b.kind === 'STALL')!;
    expect(bucket.topAgents[0]).toBe('sara');
    expect(bucket.topAgents).toContain('kai');
  });

  it('skips items with unrecognised title format (no kind tag)', () => {
    const bugs = [
      makeItem({ title: 'Random task about something else' }),
      makeItem({ title: '[Struggle/STALL] run:abc00001 — real one.' }),
    ];
    const d = analyzePatterns(bugs, 3, WINDOW);
    expect(d.totalBugs).toBe(2); // raw count unchanged
    expect(d.buckets).toHaveLength(1); // only 1 valid kind
  });

  it('sorts buckets by count descending', () => {
    const bugs = [
      makeItem({ title: '[Struggle/THRASH] run:a — loop.' }),
      ...Array.from({ length: 4 }, (_, i) =>
        makeItem({ title: `[Struggle/STALL] run:${String(i).padStart(8, '0')} — silent.` }),
      ),
    ];
    const d = analyzePatterns(bugs, 3, WINDOW);
    expect(d.buckets[0].kind).toBe('STALL');
    expect(d.buckets[1].kind).toBe('THRASH');
  });
});

// ─── buildDigestBody ──────────────────────────────────────────────────────────

describe('buildDigestBody', () => {
  it('includes window, total bugs, and threshold', () => {
    const digest: ReviewDigest = {
      windowMs: 7 * 24 * 60 * 60 * 1000,
      fetchedAt: 1718000000000,
      totalBugs: 5,
      buckets: [],
      systemicCount: 0,
    };
    const text = buildDigestBody(digest, 3);
    expect(text).toContain('7d');
    expect(text).toContain('5');
    expect(text).toContain('≥3');
  });

  it('renders no-bugs message for empty buckets', () => {
    const digest: ReviewDigest = {
      windowMs: 7 * 24 * 60 * 60 * 1000,
      fetchedAt: 1718000000000,
      totalBugs: 0,
      buckets: [],
      systemicCount: 0,
    };
    expect(buildDigestBody(digest, 3)).toContain('No struggle bugs');
  });

  it('marks systemic buckets with SYSTEMIC tag and architecture action note', () => {
    const digest: ReviewDigest = {
      windowMs: 7 * 24 * 60 * 60 * 1000,
      fetchedAt: 1718000000000,
      totalBugs: 4,
      buckets: [
        {
          kind: 'STALL',
          count: 4,
          topAgents: ['sara'],
          topDiagnoses: ['Agent silent for 20 turns.'],
          isSystemic: true,
        },
      ],
      systemicCount: 1,
    };
    const text = buildDigestBody(digest, 3);
    expect(text).toContain('SYSTEMIC');
    expect(text).toContain('Architecture action');
  });

  it('marks low-count buckets as one-off', () => {
    const digest: ReviewDigest = {
      windowMs: 7 * 24 * 60 * 60 * 1000,
      fetchedAt: 1718000000000,
      totalBugs: 2,
      buckets: [
        {
          kind: 'THRASH',
          count: 2,
          topAgents: [],
          topDiagnoses: [],
          isSystemic: false,
        },
      ],
      systemicCount: 0,
    };
    const text = buildDigestBody(digest, 3);
    expect(text).toContain('one-off');
    expect(text).not.toContain('Architecture action');
  });
});

// ─── runReview (integration-level, fetch mocked) ──────────────────────────────

describe('runReview', () => {
  beforeEach(() => {
    process.env['PULSE_SERVICE_TOKEN'] = 'test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['PULSE_SERVICE_TOKEN'];
    delete process.env['SCLI35_SYSTEMIC_THRESHOLD'];
  });

  it('returns null and skips when PULSE_SERVICE_TOKEN is absent', async () => {
    delete process.env['PULSE_SERVICE_TOKEN'];
    const result = await runReview({ pulseBaseUrl: 'http://pulse.test' });
    expect(result).toBeNull();
  });

  it('returns digest with no bugs when Pulse returns empty results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [], next: null }), { status: 200 }),
    ));
    const result = await runReview({ pulseBaseUrl: 'http://pulse.test', serviceToken: 'tok' });
    expect(result).not.toBeNull();
    expect(result!.totalBugs).toBe(0);
    // No filing attempt — fetch was called only for the bug list, not POST
    const fetchMock = vi.mocked(fetch);
    const postCalls = fetchMock.mock.calls.filter(([, opts]) => (opts as RequestInit)?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('resolves a relative DRF `next` pagination link to an absolute same-origin URL', async () => {
    // DRF returns a path-only `next` on page 1; Node fetch() rejects relative
    // URLs, so paging must resolve it against the base origin before re-fetching.
    const getUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      const urlStr = String(url);
      if ((opts as RequestInit)?.method === 'POST') {
        return new Response(JSON.stringify({ item_key: 'SCLI-201' }), { status: 201 });
      }
      if (urlStr.includes('scli-33-struggle-auto-filer')) {
        getUrls.push(urlStr);
        // Page 1 hands back a RELATIVE next link; page 2 ends the walk.
        if (!urlStr.includes('page=2')) {
          return new Response(JSON.stringify({
            results: [makeItem({ title: '[Struggle/STALL] run:pg100001 — silent.' })],
            next: '/api/items/?source=scli-33-struggle-auto-filer&page=2',
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          results: [makeItem({ title: '[Struggle/STALL] run:pg100002 — silent.' })],
          next: null,
        }), { status: 200 });
      }
      // dedup search — no existing digest
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }));

    const result = await runReview({ pulseBaseUrl: 'http://pulse.test', serviceToken: 'tok' });

    expect(result).not.toBeNull();
    expect(result!.totalBugs).toBe(2); // both pages walked → 2 bugs collected
    // The page-2 fetch used an absolute URL built from the base origin.
    const page2 = getUrls.find((u) => u.includes('page=2'));
    expect(page2).toBe('http://pulse.test/api/items/?source=scli-33-struggle-auto-filer&page=2');
  });

  it('files a new digest task when bugs are found and no open digest exists', async () => {
    const postedBodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      if ((opts as RequestInit)?.method === 'POST') {
        postedBodies.push(JSON.parse((opts as RequestInit).body as string));
        return new Response(JSON.stringify({ item_key: 'SCLI-200' }), { status: 201 });
      }
      // GET: first call = struggle bugs list; subsequent = dedup search
      const urlStr = String(url);
      if (urlStr.includes('scli-33-struggle-auto-filer')) {
        return new Response(JSON.stringify({
          results: [
            makeItem({ title: '[Struggle/STALL] run:aaaa0001 — silent.' }),
            makeItem({ title: '[Struggle/STALL] run:aaaa0002 — silent.' }),
            makeItem({ title: '[Struggle/STALL] run:aaaa0003 — silent.' }),
          ],
          next: null,
        }), { status: 200 });
      }
      // dedup search — no existing digest
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }));

    const result = await runReview({
      pulseBaseUrl: 'http://pulse.test',
      serviceToken: 'tok',
      systemicThreshold: 3,
    });

    expect(result).not.toBeNull();
    expect(result!.totalBugs).toBe(3);
    expect(result!.systemicCount).toBe(1);
    expect(postedBodies).toHaveLength(1);
    const body = postedBodies[0] as Record<string, unknown>;
    expect(body['title']).toContain('[SCLI-35 Digest]');
    expect(body['title']).toContain('systemic');
    expect(body['assignment_group']).toBe('architecture');
    expect(body['reporter_email']).toBe('aoi@shizuha.com');
  });

  it('comments on existing open digest task instead of filing a new one', async () => {
    const postedCommentBodies: unknown[] = [];
    const postedCommentUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      const urlStr = String(url);
      if ((opts as RequestInit)?.method === 'POST') {
        postedCommentUrls.push(urlStr);
        postedCommentBodies.push(JSON.parse((opts as RequestInit).body as string));
        return new Response(JSON.stringify({ id: 99 }), { status: 201 });
      }
      if (urlStr.includes('scli-33-struggle-auto-filer')) {
        return new Response(JSON.stringify({
          results: [makeItem({ title: '[Struggle/THRASH] run:xyz00001 — looping.' })],
          next: null,
        }), { status: 200 });
      }
      // Dedup search — existing open digest
      return new Response(JSON.stringify({
        results: [{ id: 50, title: '[SCLI-35 Digest] existing', status: 'open', item_key: 'SCLI-50' }],
      }), { status: 200 });
    }));

    const result = await runReview({
      pulseBaseUrl: 'http://pulse.test',
      serviceToken: 'tok',
    });

    expect(result).not.toBeNull();
    // Comment must POST to the nested item endpoint /api/items/{id}/comments/,
    // not a non-existent top-level /api/comments/ collection.
    expect(postedCommentUrls).toHaveLength(1);
    expect(postedCommentUrls[0]).toBe('http://pulse.test/api/items/50/comments/');
    expect(postedCommentBodies).toHaveLength(1);
    const commentBody = postedCommentBodies[0] as Record<string, unknown>;
    // The nested endpoint infers the item from the URL — body carries content only.
    expect(commentBody['item_key']).toBeUndefined();
    expect(typeof commentBody['content']).toBe('string');
  });

  it('never throws even when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(runReview({ pulseBaseUrl: 'http://pulse.test', serviceToken: 'tok' })).resolves.toBeNull();
  });
});
