/**
 * PLAT-4536: Role-seat live-probe evaluator (observe-mode foundation).
 *
 * Architecture contract (sora, ORIG-18 determination recorded on PLAT-4536):
 * advertise a capability only when its role seat is materialized AND its exact
 * live prerequisites pass an ACTION-SPECIFIC probe — never from mere
 * credential-existence, scope-membership, or a shared/legacy GitHub identity.
 * `author != reviewer != merger` is invariant; repository authority is each
 * agent's OWN Origin/Forgejo identity (GitHub is a read-only mirror and can
 * never satisfy a role probe).
 *
 * This is the single shared evaluator meant to be invoked IDENTICALLY at
 * initial render and every reconcile, so the two capability matrices are equal
 * by construction. It currently runs in OBSERVE mode: it computes verdicts,
 * emits diagnostics + an edge-triggered, deduplicated owner alert, and does
 * NOT withhold any capability — so it is always safe to run on the live fleet.
 * Enforce-mode withholding (fail-closed advertisement) and legacy shared-token
 * deletion land as separately reviewed follow-ups, only after observe-mode
 * verdicts are proven against reality on live canary pods.
 *
 * Gated on ROLE_SEAT_PROBE_MODE = off | observe | enforce (default off).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentInfo } from './types.js';

export type RoleSeatProbeMode = 'off' | 'observe' | 'enforce';

export type RoleSeatKind =
  | 'origin-author'
  | 'origin-review'
  | 'origin-merge'
  | 'kube-privileged'
  | 'fleet-ssh'
  | 'broker-credential';

export type ProbeVerdict = 'pass' | 'fail' | 'indeterminate';

/** A single seat-probe outcome. `evidence` is the probe name + result and MUST
 *  NEVER contain credential/secret material. */
export interface SeatProbeResult {
  seat: RoleSeatKind;
  /** The advertised capability/scope this seat backs (e.g. 'github:merge'). */
  capability: string;
  verdict: ProbeVerdict;
  evidence: string;
  checkedAt: string;
}

/** Own-identity Forgejo/Origin auth for the agent under probe. */
export interface ForgejoSeatAuth {
  /** The agent's OWN Origin/Forgejo API token (never a shared team token). */
  token: string;
  /** The agent's OWN expected Forgejo login (e.g. 'sara2574'). */
  expectedLogin: string;
  /** Origin API base, e.g. https://origin.shizuha.com or the in-cluster svc. */
  baseUrl: string;
  /** Repo whose permissions the action probe reads (owner/name). */
  probeRepo?: string;
}

/** Injected probe implementations. A missing dep yields `indeterminate` (never
 *  a false pass). The manager wires real accessors; tests wire fakes. */
export interface RoleSeatProbeDeps {
  /**
   * Preferred Origin/Forgejo seat probe. The agent's own token lives in the
   * agent POD (rendered from a Secret), not in the manager process, so the
   * real probe execs into the pod (`kubectl exec … deployment/agent-<user>`)
   * and checks identity + action there — see role-seat-probe-deps.ts. Injected
   * like the kube/ssh/broker deps; a fault maps to `indeterminate`, never pass.
   */
  probeOriginSeat?: (
    agent: AgentInfo,
    seat: 'origin-author' | 'origin-review' | 'origin-merge',
  ) => Promise<{ verdict: ProbeVerdict; evidence: string }>;
  /**
   * Fallback path for a caller that DOES hold the agent's own Origin auth
   * (e.g. tests) — resolves it for the fetch-based `probeForgejoSeat`. Used
   * only when `probeOriginSeat` is not provided.
   */
  getForgejoAuth?: (agent: AgentInfo) => Promise<ForgejoSeatAuth | null>;
  /** Live kube authorization probe (SelfSubjectAccessReview / `auth can-i`). */
  runKubeAccessReview?: (agent: AgentInfo) => Promise<ProbeVerdict>;
  /** Live credential-broker round-trip (token resolvable + non-empty). */
  brokerRoundTrip?: (agent: AgentInfo, scope: string) => Promise<ProbeVerdict>;
  /** Live SSH target-authorization probe (BatchMode connect, not key-file). */
  sshAuthzCheck?: (agent: AgentInfo) => Promise<ProbeVerdict>;
  /**
   * Live PR-review-authority probe for the origin-review seat — a non-mutating
   * team/branch review-permission check, or a safely disposable pending-review
   * create+delete. Repo read (`pull`) does NOT prove review authority (revi P1
   * #3), so this is the positive proof; when absent, the review seat falls back
   * to fail-closed in probeForgejoSeat.
   */
  reviewAuthorityCheck?: (agent: AgentInfo) => Promise<ProbeVerdict>;
  /** For unit substitution; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function roleSeatProbeMode(env: NodeJS.ProcessEnv = process.env): RoleSeatProbeMode {
  const raw = String(env['ROLE_SEAT_PROBE_MODE'] ?? '').trim().toLowerCase();
  return raw === 'observe' || raw === 'enforce' ? raw : 'off';
}

interface SeatCandidate {
  seat: RoleSeatKind;
  capability: string;
}

/**
 * Derive the candidate role seats an agent currently ADVERTISES, from its
 * effective capabilities + credential-grant scopes. Note: the runtime today
 * collapses `github:review`/`github:merge` -> `github`
 * (effective-capabilities.ts:175); we still emit distinct seats when the
 * qualified scope survives, and fall back to origin-author for a bare `github`.
 * Preserving that distinction end-to-end is part of the enforce follow-up.
 */
export function deriveCandidateSeats(agent: AgentInfo): SeatCandidate[] {
  const effective = agent.effectiveCapabilities;
  if (!effective) return [];
  const scopes = (effective.credentialGrantScopes ?? []).map((s) => String(s).toLowerCase());
  const caps = (effective.capabilities ?? []).map((c) => String(c).toLowerCase());
  const has = (v: string) => scopes.includes(v) || caps.includes(v);
  const out: SeatCandidate[] = [];

  if (has('github:merge')) out.push({ seat: 'origin-merge', capability: 'github:merge' });
  if (has('github:review')) out.push({ seat: 'origin-review', capability: 'github:review' });
  // A bare `github` scope backs the author seat (push a branch / open a PR).
  if (scopes.includes('github') && !has('github:merge') && !has('github:review')) {
    out.push({ seat: 'origin-author', capability: 'github' });
  }
  if (has('kubeconfig') || caps.includes('privileged-infra') || caps.includes('deploy')) {
    out.push({ seat: 'kube-privileged', capability: 'kubeconfig' });
  }
  if (scopes.some((s) => s.startsWith('fleet-ssh')) || caps.includes('host-exec')) {
    out.push({ seat: 'fleet-ssh', capability: 'fleet-ssh' });
  }
  return out;
}

const nowIso = (): string => new Date().toISOString();

/**
 * Action-specific Origin/Forgejo probe. Verifies (1) the token authenticates as
 * the agent's OWN login (never a shared identity), and (2) the exact repo
 * permission the seat claims: author => push, review => pull, merge =>
 * admin||maintain. Any network/auth error is `indeterminate` (never a pass).
 */
export async function probeForgejoSeat(
  auth: ForgejoSeatAuth,
  seat: 'origin-author' | 'origin-review' | 'origin-merge',
  fetchImpl: typeof fetch = fetch,
): Promise<{ verdict: ProbeVerdict; evidence: string }> {
  const base = auth.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `token ${auth.token}`, Accept: 'application/json' };
  try {
    const uResp = await fetchImpl(`${base}/api/v1/user`, { headers });
    if (uResp.status === 401 || uResp.status === 403) {
      return { verdict: 'fail', evidence: `forgejo /user auth ${uResp.status}` };
    }
    if (!uResp.ok) return { verdict: 'indeterminate', evidence: `forgejo /user http ${uResp.status}` };
    const login = String(((await uResp.json()) as { login?: unknown })?.login ?? '');
    if (login.toLowerCase() !== auth.expectedLogin.toLowerCase()) {
      // Shared/legacy identity would surface here — fail closed, never advertise.
      return { verdict: 'fail', evidence: `forgejo identity mismatch: token=${login} expected=own` };
    }
    if (!auth.probeRepo) {
      // Identity proven but no repo to action-probe: cannot prove the seat.
      return { verdict: 'indeterminate', evidence: `forgejo identity ok (${seat}); no probeRepo` };
    }
    const rResp = await fetchImpl(`${base}/api/v1/repos/${auth.probeRepo}`, { headers });
    if (rResp.status === 404 || rResp.status === 403) {
      return { verdict: 'fail', evidence: `forgejo repo ${seat} perm ${rResp.status}` };
    }
    if (!rResp.ok) return { verdict: 'indeterminate', evidence: `forgejo repo http ${rResp.status}` };
    const perms = (((await rResp.json()) as { permissions?: Record<string, unknown> })?.permissions) ?? {};
    const admin = perms['admin'] === true;
    const push = perms['push'] === true;
    const pull = perms['pull'] === true;
    if (seat === 'origin-review') {
      // revi P1 #3: repo `pull` (read) does NOT prove authority to POST a formal
      // PR review, so a read-scoped identity must FAIL review-seat proof here — it
      // must never advertise the reviewer seat off read access. Repo permissions
      // expose no review-specific authority, so the perms path cannot prove this
      // seat: it fails closed. The POSITIVE proof is the injected
      // `reviewAuthorityCheck` dep (a non-mutating team-review-permission check,
      // or a safely disposable pending-review create+delete), preferred in
      // seatAuthorityCheck when wired; this perms path is the fail-closed fallback.
      return {
        verdict: 'fail',
        evidence: `forgejo review seat: repo perms (pull=${pull}) do not prove PR-review authority (own identity ${login})`,
      };
    }
    const ok = seat === 'origin-merge' ? admin : push; // author => push, merge => admin
    return ok
      ? { verdict: 'pass', evidence: `forgejo ${seat} perm ok (own identity ${login})` }
      : { verdict: 'fail', evidence: `forgejo ${seat} perm insufficient` };
  } catch (err) {
    return { verdict: 'indeterminate', evidence: `forgejo probe error: ${(err as Error).name}` };
  }
}

type Check = { verdict: ProbeVerdict; evidence: string };

/** Prove that the token under test belongs to the agent's own Origin identity.
 * Review authority is checked separately: both proofs must pass. */
async function probeForgejoIdentity(
  auth: ForgejoSeatAuth,
  fetchImpl: typeof fetch = fetch,
): Promise<Check> {
  const base = auth.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `token ${auth.token}`, Accept: 'application/json' };
  try {
    const response = await fetchImpl(`${base}/api/v1/user`, { headers });
    if (response.status === 401 || response.status === 403) {
      return { verdict: 'fail', evidence: `forgejo /user auth ${response.status}` };
    }
    if (!response.ok) return { verdict: 'indeterminate', evidence: `forgejo /user http ${response.status}` };
    const login = String(((await response.json()) as { login?: unknown })?.login ?? '');
    return login.toLowerCase() === auth.expectedLogin.toLowerCase()
      ? { verdict: 'pass', evidence: 'forgejo own identity proven' }
      : { verdict: 'fail', evidence: 'forgejo identity mismatch: expected own identity' };
  } catch (err) {
    return { verdict: 'indeterminate', evidence: `forgejo identity probe error: ${(err as Error).name}` };
  }
}

/** Run a probe closure fail-CLOSED: any thrown transport/exec fault maps to
 *  `indeterminate` (never lost, never a silent pass). (revi P1 #1.) */
async function guardedCheck(
  fn: () => Promise<Check>,
  faultEvidence: string,
): Promise<Check> {
  try {
    return await fn();
  } catch (err) {
    return { verdict: 'indeterminate', evidence: `${faultEvidence}: ${(err as Error).name}` };
  }
}

/** Conjunction over a seat's REQUIRED checks (revi P1 #2): pass ONLY if every
 *  required check passes; any `fail` => fail; otherwise any `indeterminate` =>
 *  indeterminate. An empty check set is `indeterminate` (nothing proven). */
function combineConjuncts(checks: Check[]): Check {
  if (checks.length === 0) return { verdict: 'indeterminate', evidence: 'no probe wired' };
  const failed = checks.find((c) => c.verdict === 'fail');
  if (failed) return { verdict: 'fail', evidence: failed.evidence };
  const unknown = checks.find((c) => c.verdict === 'indeterminate');
  if (unknown) return { verdict: 'indeterminate', evidence: unknown.evidence };
  return { verdict: 'pass', evidence: checks.map((c) => c.evidence).join('; ') };
}

/** The seat's action-authority check (Origin/kube/SSH), each fault-guarded. */
async function seatAuthorityCheck(
  agent: AgentInfo,
  c: SeatCandidate,
  deps: RoleSeatProbeDeps,
  fetchImpl: typeof fetch,
): Promise<Check> {
  return guardedCheck(async () => {
    if (c.seat === 'origin-author' || c.seat === 'origin-review' || c.seat === 'origin-merge') {
      if (c.seat === 'origin-review') {
        let identity: Check;
        if (deps.probeOriginSeat) {
          identity = await deps.probeOriginSeat(agent, c.seat);
        } else if (deps.getForgejoAuth) {
          const auth = await deps.getForgejoAuth(agent);
          identity = auth
            ? await probeForgejoIdentity(auth, fetchImpl)
            : { verdict: 'indeterminate', evidence: 'forgejo auth unavailable' };
        } else {
          identity = { verdict: 'indeterminate', evidence: 'origin identity probe unavailable' };
        }
        const authority: Check = deps.reviewAuthorityCheck
          ? { verdict: await deps.reviewAuthorityCheck(agent), evidence: 'review-authority probe' }
          : { verdict: 'indeterminate', evidence: 'review-authority probe unavailable' };
        return combineConjuncts([identity, authority]);
      }
      if (deps.probeOriginSeat) return await deps.probeOriginSeat(agent, c.seat);
      if (deps.getForgejoAuth) {
        const auth = await deps.getForgejoAuth(agent);
        if (!auth) return { verdict: 'indeterminate', evidence: 'forgejo auth unavailable' };
        return await probeForgejoSeat(auth, c.seat, fetchImpl);
      }
      return { verdict: 'indeterminate', evidence: 'origin probe unavailable' };
    }
    if (c.seat === 'kube-privileged') {
      if (deps.runKubeAccessReview) {
        return { verdict: await deps.runKubeAccessReview(agent), evidence: 'kube SelfSubjectAccessReview' };
      }
      return { verdict: 'indeterminate', evidence: 'kube probe unavailable' };
    }
    if (c.seat === 'fleet-ssh') {
      if (deps.sshAuthzCheck) {
        return { verdict: await deps.sshAuthzCheck(agent), evidence: 'ssh target authorization' };
      }
      return { verdict: 'indeterminate', evidence: 'ssh probe unavailable' };
    }
    return { verdict: 'indeterminate', evidence: 'no probe wired' };
  }, `${c.seat} probe error`);
}

/**
 * Run the full seat matrix for an agent. Every seat is proven ONLY when all its
 * required live prerequisites pass — the action-authority probe AND, when wired,
 * the credential-broker liveness (revi P1 #2). Each dependency is individually
 * fault-guarded so a transport error yields `indeterminate` for that candidate
 * rather than being lost (revi P1 #1). Missing deps => indeterminate, never pass.
 */
export async function evaluateRoleSeats(
  agent: AgentInfo,
  deps: RoleSeatProbeDeps = {},
): Promise<SeatProbeResult[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const candidates = deriveCandidateSeats(agent);
  const results: SeatProbeResult[] = [];
  for (const c of candidates) {
    const checks: Check[] = [await seatAuthorityCheck(agent, c, deps, fetchImpl)];
    // Credential-broker liveness is REQUIRED for every seat. Missing wiring is
    // unproven and therefore indeterminate, never a pass.
    if (deps.brokerRoundTrip) {
      checks.push(
        await guardedCheck(
          async () => ({
            verdict: await deps.brokerRoundTrip!(agent, c.capability),
            evidence: `broker round-trip (${c.capability})`,
          }),
          `broker probe error (${c.capability})`,
        ),
      );
    } else {
      checks.push({ verdict: 'indeterminate', evidence: 'broker probe unavailable' });
    }
    const { verdict, evidence } = combineConjuncts(checks);
    results.push({ seat: c.seat, capability: c.capability, verdict, evidence, checkedAt: nowIso() });
  }
  return results;
}

export type SeatTransition = 'withdrawn' | 'recovered' | 'steady';

/**
 * Edge-trigger tracker: emits an alert only on a capability's withdraw/recover
 * transition (pass<->not-pass), never while steady — mirrors the reconciler's
 * driftCyclesByAgent edge pattern. Keyed per (agent, seat, capability).
 */
export class RoleSeatProbeTracker {
  private last = new Map<string, ProbeVerdict>();

  private key(agentId: string, r: SeatProbeResult): string {
    return `${agentId}:${r.seat}:${r.capability}`;
  }

  /** Record a fresh result; returns the state transition since the prior one. */
  record(agentId: string, r: SeatProbeResult): SeatTransition {
    const k = this.key(agentId, r);
    const prev = this.last.get(k);
    this.last.set(k, r.verdict);
    if (prev === undefined) {
      // First observation: only a non-pass is noteworthy (fail-closed default).
      return r.verdict === 'pass' ? 'steady' : 'withdrawn';
    }
    const wasProven = prev === 'pass';
    const isProven = r.verdict === 'pass';
    if (wasProven && !isProven) return 'withdrawn';
    if (!wasProven && isProven) return 'recovered';
    return 'steady';
  }

  reset(agentId: string): void {
    for (const k of [...this.last.keys()]) {
      if (k.startsWith(`${agentId}:`)) this.last.delete(k);
    }
  }
}

/**
 * Best-effort deduplicated owner alert on a capability withdraw/recover edge.
 * Reuses the LocalPulseStore.fireAlert dedup (source_id) pattern. NEVER carries
 * secret material — evidence is the probe name + verdict only.
 */
export function emitRoleSeatCapabilityAlert(
  agent: AgentInfo,
  result: SeatProbeResult,
  transition: 'withdrawn' | 'recovered',
): void {
  // revi P1 #4: include the transition in source_id so a `recovered` alert is
  // NOT deduplicated by LocalPulseStore.fireAlert as a duplicate of the earlier
  // `withdrawn` alert (they must be distinct events). Per-state dedup is retained
  // — the edge-triggered tracker only fires on an actual transition, so repeated
  // withdrawals while steady never reach here, and each transition kind collapses
  // duplicates on its own key.
  const alertKey = `roleseat-cap:${agent.id}:${result.seat}:${result.capability}:${transition}`;
  const withdrawn = transition === 'withdrawn';
  void import('../pulse/local-store.js')
    .then(({ LocalPulseStore }) => {
      const pulseDb = path.join(process.env['HOME'] ?? os.homedir(), '.shizuha', 'pulse-local.db');
      const store = new LocalPulseStore(pulseDb);
      try {
        store.fireAlert({
          title: `Role-seat capability ${transition} for ${agent.username}: ${result.capability}`,
          description:
            `Live probe for the ${result.seat} seat (${result.capability}) is now `
            + `"${result.verdict}" (${result.evidence}). `
            + (withdrawn
              ? 'Advertised capability is not currently proven live for this seat + own identity.'
              : 'Capability re-proved by a fresh passing probe.'),
          item_type: 'alert.security.role_seat_capability',
          severity: withdrawn ? 'critical' : 'info',
          source: 'shizuha-daemon',
          source_id: alertKey,
          labels: ['PLAT-4536', 'role-seat', 'capability-probe', result.seat],
          payload: {
            agent_id: agent.id,
            agent_username: agent.username,
            seat: result.seat,
            capability: result.capability,
            verdict: result.verdict,
            transition,
            evidence: result.evidence,
            checked_at: result.checkedAt,
          },
          created_by: 'shizuha-daemon',
        });
      } finally {
        store.close();
      }
    })
    .catch(() => {
      /* best-effort: alerting must never disrupt the refresh cycle */
    });
}

/**
 * OBSERVE-mode entry point. Runs the seat matrix, emits edge-triggered owner
 * alerts, returns the results for diagnostics/logging. Never withholds a
 * capability. Safe to call from the shared materializer at render + reconcile.
 * No-op (returns []) unless ROLE_SEAT_PROBE_MODE is observe|enforce.
 */
export async function observeRoleSeats(
  agent: AgentInfo,
  tracker: RoleSeatProbeTracker,
  deps: RoleSeatProbeDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeatProbeResult[]> {
  if (roleSeatProbeMode(env) === 'off') return [];
  let results: SeatProbeResult[];
  try {
    results = await evaluateRoleSeats(agent, deps);
  } catch (err) {
    // Fail-closed (revi P1 #1): an unexpected evaluator fault must NOT read as
    // "no seats" (a clean agent). Emit `indeterminate` for every advertised
    // candidate so the withdrawal edge/alert still fires and the enforce caller
    // can distinguish "probe execution failed" from "no advertised seats".
    const checkedAt = nowIso();
    let candidates: SeatCandidate[] = [];
    try {
      candidates = deriveCandidateSeats(agent);
    } catch {
      candidates = [];
    }
    results = candidates.map((c) => ({
      seat: c.seat,
      capability: c.capability,
      verdict: 'indeterminate' as ProbeVerdict,
      evidence: `evaluator fault: ${(err as Error).name}`,
      checkedAt,
    }));
  }
  for (const r of results) {
    const transition = tracker.record(agent.id, r);
    if (transition === 'withdrawn' || transition === 'recovered') {
      emitRoleSeatCapabilityAlert(agent, r, transition);
    }
  }
  return results;
}
