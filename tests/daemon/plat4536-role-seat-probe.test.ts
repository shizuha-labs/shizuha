import { describe, it, expect } from 'vitest';
import {
  evaluateRoleSeats,
  probeForgejoSeat,
  observeRoleSeats,
  RoleSeatProbeTracker,
  type ForgejoSeatAuth,
  type ProbeVerdict,
  type SeatProbeResult,
} from '../../src/daemon/role-seat-probe.js';
import type { AgentInfo } from '../../src/daemon/types.js';

// PLAT-4536 — deterministic coverage for revi's review findings on the live
// role-seat probe evaluator (exact head 96f33a77). Security-sensitive
// state-machine logic: every seat is proven ONLY when all required live
// prerequisites pass; faults are indeterminate (never a false pass); the reviewer
// seat is not provable from repo read; alert edges fire once per transition.

const agent = (caps: string[] = [], scopes: string[] = []): AgentInfo =>
  ({
    id: 'agent-sara',
    username: 'sara2574',
    effectiveCapabilities: { capabilities: caps, credentialGrantScopes: scopes },
  }) as unknown as AgentInfo;

const AUTH: ForgejoSeatAuth = {
  token: 't',
  expectedLogin: 'sara2574',
  baseUrl: 'http://origin.test',
  probeRepo: 'shizuha-labs/deploy',
};

/** Fake fetch: /api/v1/user -> {login}; /repos/<repo> -> {permissions}. */
function makeFetch(opts: {
  login?: string;
  perms?: Record<string, boolean>;
  userStatus?: number;
  repoStatus?: number;
}): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/api/v1/user')) {
      const s = opts.userStatus ?? 200;
      return { ok: s < 400, status: s, json: async () => ({ login: opts.login ?? 'sara2574' }) } as Response;
    }
    const s = opts.repoStatus ?? 200;
    return { ok: s < 400, status: s, json: async () => ({ permissions: opts.perms ?? {} }) } as Response;
  }) as unknown as typeof fetch;
}

const result = (verdict: ProbeVerdict, seat = 'origin-author', capability = 'github'): SeatProbeResult =>
  ({ seat, capability, verdict, evidence: '', checkedAt: '' }) as SeatProbeResult;

describe('PLAT-4536 role-seat probe — revi P1 #1: faults are indeterminate, never lost', () => {
  it('a thrown Origin probe -> indeterminate result for the candidate (not dropped)', async () => {
    const res = await evaluateRoleSeats(agent([], ['github']), {
      probeOriginSeat: async () => {
        throw new Error('kubectl exec failed');
      },
    });
    expect(res).toHaveLength(1);
    expect(res[0].seat).toBe('origin-author');
    expect(res[0].verdict).toBe('indeterminate');
  });

  it('a thrown kube probe -> indeterminate', async () => {
    const res = await evaluateRoleSeats(agent(['privileged-infra']), {
      runKubeAccessReview: async () => {
        throw new Error('apiserver unreachable');
      },
    });
    expect(res[0].seat).toBe('kube-privileged');
    expect(res[0].verdict).toBe('indeterminate');
  });

  it('a thrown SSH probe -> indeterminate', async () => {
    const res = await evaluateRoleSeats(agent(['host-exec']), {
      sshAuthzCheck: async () => {
        throw new Error('connect timeout');
      },
    });
    expect(res[0].verdict).toBe('indeterminate');
  });

  it('a thrown broker probe -> indeterminate even though authority passed', async () => {
    const res = await evaluateRoleSeats(agent([], ['github']), {
      probeOriginSeat: async () => ({ verdict: 'pass', evidence: 'authority ok' }),
      brokerRoundTrip: async () => {
        throw new Error('broker socket closed');
      },
    });
    expect(res[0].verdict).toBe('indeterminate');
  });

  it('observeRoleSeats emits indeterminate-per-candidate on a total evaluator fault, not []', async () => {
    // deriveCandidateSeats sees the scope; a thrown dep must still yield a
    // withdrawal-eligible indeterminate result, never a clean "no seats".
    const res = await observeRoleSeats(
      agent([], ['github']),
      new RoleSeatProbeTracker(),
      {
        probeOriginSeat: async () => {
          throw new Error('boom');
        },
      },
      { ROLE_SEAT_PROBE_MODE: 'observe' } as NodeJS.ProcessEnv,
    );
    expect(res).toHaveLength(1);
    expect(res[0].verdict).toBe('indeterminate');
  });
});

describe('PLAT-4536 role-seat probe — revi P1 #2: broker is a REQUIRED conjunct', () => {
  it('broker fail => seat fail even when action authority passes', async () => {
    const res = await evaluateRoleSeats(agent([], ['github']), {
      probeOriginSeat: async () => ({ verdict: 'pass', evidence: 'authority ok' }),
      brokerRoundTrip: async () => 'fail',
    });
    expect(res[0].verdict).toBe('fail');
  });

  it('all required checks pass => pass', async () => {
    const res = await evaluateRoleSeats(agent([], ['github']), {
      probeOriginSeat: async () => ({ verdict: 'pass', evidence: 'authority ok' }),
      brokerRoundTrip: async () => 'pass',
    });
    expect(res[0].verdict).toBe('pass');
  });

  it('broker indeterminate (authority pass) => indeterminate, never a pass', async () => {
    const res = await evaluateRoleSeats(agent([], ['github']), {
      probeOriginSeat: async () => ({ verdict: 'pass', evidence: 'authority ok' }),
      brokerRoundTrip: async () => 'indeterminate',
    });
    expect(res[0].verdict).toBe('indeterminate');
  });

  it('authority fail => fail regardless of a passing broker', async () => {
    const res = await evaluateRoleSeats(agent([], ['github']), {
      probeOriginSeat: async () => ({ verdict: 'fail', evidence: 'no push' }),
      brokerRoundTrip: async () => 'pass',
    });
    expect(res[0].verdict).toBe('fail');
  });

  it('a seat with no wired probe is indeterminate, never pass', async () => {
    const res = await evaluateRoleSeats(agent([], ['github']), {});
    expect(res[0].verdict).toBe('indeterminate');
  });

  it('authority pass with broker wiring missing => indeterminate, never pass', async () => {
    const res = await evaluateRoleSeats(agent([], ['github']), {
      probeOriginSeat: async () => ({ verdict: 'pass', evidence: 'authority ok' }),
    });
    expect(res[0].verdict).toBe('indeterminate');
  });
});

describe('PLAT-4536 role-seat probe — revi P1 #3: reviewer seat needs review authority', () => {
  it('review seat with only repo pull => FAIL (read != review authority)', async () => {
    const res = await probeForgejoSeat(
      AUTH,
      'origin-review',
      makeFetch({ login: 'sara2574', perms: { pull: true, push: false, admin: false } }),
    );
    expect(res.verdict).toBe('fail');
  });

  it('review seat passes only when own identity, review authority, and broker pass', async () => {
    const res = await evaluateRoleSeats(agent([], ['github:review']), {
      probeOriginSeat: async () => ({ verdict: 'pass', evidence: 'own identity proven' }),
      reviewAuthorityCheck: async () => 'pass',
      brokerRoundTrip: async () => 'pass',
    });
    expect(res[0].seat).toBe('origin-review');
    expect(res[0].verdict).toBe('pass');
  });

  it('review authority pass with own identity unproven => indeterminate', async () => {
    const res = await evaluateRoleSeats(agent([], ['github:review']), {
      reviewAuthorityCheck: async () => 'pass',
      brokerRoundTrip: async () => 'pass',
    });
    expect(res[0].verdict).toBe('indeterminate');
  });

  it('review authority pass with own identity mismatch => fail', async () => {
    const res = await evaluateRoleSeats(agent([], ['github:review']), {
      getForgejoAuth: async () => AUTH,
      reviewAuthorityCheck: async () => 'pass',
      brokerRoundTrip: async () => 'pass',
      fetchImpl: makeFetch({ login: 'kai2574' }),
    });
    expect(res[0].verdict).toBe('fail');
  });

  it('author seat = repo push', async () => {
    const pass = await probeForgejoSeat(AUTH, 'origin-author', makeFetch({ perms: { push: true } }));
    expect(pass.verdict).toBe('pass');
    const fail = await probeForgejoSeat(AUTH, 'origin-author', makeFetch({ perms: { push: false, pull: true } }));
    expect(fail.verdict).toBe('fail');
  });

  it('merge seat = repo admin (push alone is insufficient)', async () => {
    const fail = await probeForgejoSeat(AUTH, 'origin-merge', makeFetch({ perms: { push: true, admin: false } }));
    expect(fail.verdict).toBe('fail');
    const pass = await probeForgejoSeat(AUTH, 'origin-merge', makeFetch({ perms: { admin: true } }));
    expect(pass.verdict).toBe('pass');
  });

  it('own-identity mismatch (shared/legacy token) => fail, never advertise', async () => {
    const res = await probeForgejoSeat(AUTH, 'origin-author', makeFetch({ login: 'kai2574', perms: { push: true } }));
    expect(res.verdict).toBe('fail');
  });

  it('auth 401 on /user => fail (own token invalid)', async () => {
    const res = await probeForgejoSeat(AUTH, 'origin-author', makeFetch({ userStatus: 401 }));
    expect(res.verdict).toBe('fail');
  });

  it('transient /user http 500 => indeterminate, never a pass', async () => {
    const res = await probeForgejoSeat(AUTH, 'origin-author', makeFetch({ userStatus: 500 }));
    expect(res.verdict).toBe('indeterminate');
  });
});

describe('PLAT-4536 role-seat probe — revi P2 #4: edge-triggered alert dedupe', () => {
  it('withdraw once, steady no-repeat, recover once', () => {
    const t = new RoleSeatProbeTracker();
    expect(t.record('a', result('pass'))).toBe('steady'); // first pass: nothing to alert
    expect(t.record('a', result('fail'))).toBe('withdrawn'); // pass -> fail
    expect(t.record('a', result('fail'))).toBe('steady'); // steady fail: NO repeat
    expect(t.record('a', result('indeterminate'))).toBe('steady'); // still not-proven
    expect(t.record('a', result('pass'))).toBe('recovered'); // -> pass
    expect(t.record('a', result('pass'))).toBe('steady'); // steady pass: NO repeat
  });

  it('first observation of a non-pass is a withdrawal (fail-closed from fresh / after restart)', () => {
    const t = new RoleSeatProbeTracker();
    expect(t.record('a', result('indeterminate', 'kube-privileged', 'kubeconfig'))).toBe('withdrawn');
  });

  it('reset re-arms fail-closed: a proven seat, after reset, re-alerts on the next non-pass', () => {
    const t = new RoleSeatProbeTracker();
    t.record('a', result('pass'));
    t.reset('a');
    expect(t.record('a', result('fail'))).toBe('withdrawn');
  });
});

describe('PLAT-4536 role-seat probe — PLAT-3412 regression', () => {
  it('fleet-ssh seat is withdrawn (fail) when SSH target authorization fails', async () => {
    const res = await evaluateRoleSeats(agent(['host-exec']), {
      sshAuthzCheck: async () => 'fail',
    });
    expect(res[0].seat).toBe('fleet-ssh');
    expect(res[0].verdict).toBe('fail');
  });
});
