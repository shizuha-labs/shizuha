import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleStruggleEvent } from '../../src/telemetry/struggle-auto-filer.js';
import type { StruggleEvent } from '../../src/events/types.js';

const MOCK_EVENT: StruggleEvent = {
  type: 'struggle',
  runId: 'abc12345-def6-7890-abcd-ef1234567890',
  kind: 'STALL',
  diagnosis: 'Agent has been silent for 20 turns without progress.',
  agent: 'test-agent',
  timestamp: 1718000000000,
  windowSummary: {
    turnsAnalyzed: 20,
    errorRate: 0.05,
    noOpRate: 0.15,
    avgTurnMs: 5000,
  },
};

function mockFetchFactory(capturedBodies: unknown[]) {
  return vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') {
      capturedBodies.push(JSON.parse(opts.body as string));
      return new Response(JSON.stringify({ item_key: 'SCLI-999' }), { status: 201 });
    }
    // dedup search: return empty results
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['PULSE_PROJECT_ID'];
});

describe('struggle-auto-filer — SCLI-33 P1 regression (project FK must be numeric)', () => {
  it('POST body sends project as a number when projectId is configured', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', mockFetchFactory(bodies));

    await handleStruggleEvent(MOCK_EVENT, {
      serviceToken: 'test-token',
      projectId: 333,
    });

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(typeof body['project']).toBe('number');
    expect(body['project']).toBe(333);
  });

  it('project field is omitted from POST body when projectId is absent', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', mockFetchFactory(bodies));
    // make sure env var is also unset
    delete process.env['PULSE_PROJECT_ID'];

    await handleStruggleEvent(MOCK_EVENT, {
      serviceToken: 'test-token',
      // no projectId
    });

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'project')).toBe(false);
  });

  it('picks up projectId from PULSE_PROJECT_ID env var', async () => {
    process.env['PULSE_PROJECT_ID'] = '42';
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', mockFetchFactory(bodies));

    await handleStruggleEvent(MOCK_EVENT, { serviceToken: 'test-token' });

    const body = bodies[0] as Record<string, unknown>;
    expect(body['project']).toBe(42);
  });

  it('does not send project as a string (regression guard)', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', mockFetchFactory(bodies));

    await handleStruggleEvent(MOCK_EVENT, {
      serviceToken: 'test-token',
      projectId: 333,
    });

    const body = bodies[0] as Record<string, unknown>;
    expect(typeof body['project']).not.toBe('string');
  });

  it('sends workflow_name (not workflow) in POST body', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', mockFetchFactory(bodies));

    await handleStruggleEvent(MOCK_EVENT, {
      serviceToken: 'test-token',
      projectId: 333,
    });

    const body = bodies[0] as Record<string, unknown>;
    expect(body['workflow_name']).toBe('autonomous-bug');
    expect(Object.prototype.hasOwnProperty.call(body, 'workflow')).toBe(false);
  });

  it('skips filing when dedup finds an open match', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        bodies.push(JSON.parse(opts.body as string));
        return new Response(JSON.stringify({ item_key: 'SCLI-999' }), { status: 201 });
      }
      // return a matching open task
      return new Response(JSON.stringify({
        results: [{ title: '[Struggle/STALL] run:abc12345-def6-7890-abcd-ef1234567890 — existing bug', status: 'open' }],
      }), { status: 200 });
    }));

    await handleStruggleEvent(MOCK_EVENT, {
      serviceToken: 'test-token',
      projectId: 333,
    });

    expect(bodies).toHaveLength(0);
  });
});
