/**
 * PLAT-5468: the people-ops audit action/query contract (PLAT-1076) must be
 * recorded and queryable from the canonical shizuha audit logger.
 *
 * Ports the two old shizuha regressions at the current consumer boundary:
 *  1. persistence/reload with mixed audit events — people-ops entries survive
 *     a logger restart and are queryable by targetAgent/tier/primitive;
 *  2. a filtered match beyond a noisy tail — a people-ops lookup crosses noisy
 *     session boundaries instead of stopping after a fixed tail window.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger } from '../../src/security/audit.js';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'people-ops-audit-'));
}

describe('PLAT-5468 people-ops audit contract', () => {
  it('persists people-ops actions and reloads them with mixed audit events', () => {
    const ws = tempWorkspace();
    const logger = new AuditLogger(ws);

    // Mixed events: a regular tool call + two people-ops actions.
    logger.logBefore('nagi', 'bash', 'ls -la', 'nagi@shizuha.com');
    const id1 = logger.logPeopleOpsAction('nagi', {
      targetAgent: 'kai', tier: 'A', primitive: 'restart_agent',
      pulseTask: 'PLAT-123', reason: 'stalled', result: 'restarted',
    });
    const id2 = logger.logPeopleOpsAction('nagi', {
      targetAgent: 'aoi', tier: 'B', primitive: 'pause_agent',
      reason: 'maintenance',
    });
    logger.close();

    // Reload: a fresh logger over the same log file (simulates restart).
    const reloaded = new AuditLogger(ws);

    const all = reloaded.query({ limit: 50 });
    expect(all.length).toBe(3);
    expect(all.filter((e) => e.tool === 'people_ops_action').length).toBe(2);

    const byTarget = reloaded.query({ targetAgent: 'kai' });
    expect(byTarget.length).toBe(1);
    expect(byTarget[0]!.id).toBe(id1);
    expect(byTarget[0]!.tier).toBe('A');
    expect(byTarget[0]!.primitive).toBe('restart_agent');
    expect(byTarget[0]!.riskFlags).toContain('people-ops');
    expect(byTarget[0]!.riskFlags).toContain('A');

    const byTier = reloaded.query({ tier: 'b' }); // tier filter is case-normalized
    expect(byTier.length).toBe(1);
    expect(byTier[0]!.id).toBe(id2);
    expect(byTier[0]!.targetAgent).toBe('aoi');

    const byPrimitive = reloaded.query({ primitive: 'restart_agent' });
    expect(byPrimitive.length).toBe(1);
    expect(byPrimitive[0]!.id).toBe(id1);
    reloaded.close();
  });

  it('finds a filtered people-ops match beyond a noisy tail', () => {
    const ws = tempWorkspace();
    const logger = new AuditLogger(ws);

    // A noisy tail of non-people-ops events (session chatter) that would stop a
    // naive fixed-tail query before reaching the matching row.
    for (let i = 0; i < 200; i++) {
      logger.logBefore(`agent-${i % 5}`, 'bash', `echo noise ${i}`, 'nagi@shizuha.com');
    }
    const matchId = logger.logPeopleOpsAction('nagi', {
      targetAgent: 'kai', tier: 'A', primitive: 'restart_agent',
    });
    logger.close();

    const reloaded = new AuditLogger(ws);
    // The filtered query must cross the 200-row noisy tail to find the match.
    const byTarget = reloaded.query({ targetAgent: 'kai' });
    expect(byTarget.length).toBe(1);
    expect(byTarget[0]!.id).toBe(matchId);

    const byPrimitive = reloaded.query({ primitive: 'restart_agent' });
    expect(byPrimitive.length).toBe(1);
    expect(byPrimitive[0]!.id).toBe(matchId);
    reloaded.close();
  });

  it('normalizes tiers and preserves risk flags', () => {
    const ws = tempWorkspace();
    const logger = new AuditLogger(ws);
    logger.logPeopleOpsAction('nagi', {
      targetAgent: 'kai', tier: '  tier-a ', primitive: ' pause_agent ',
    });
    logger.close();

    const reloaded = new AuditLogger(ws);
    const entry = reloaded.query({ targetAgent: 'kai' })[0]!;
    expect(entry.tier).toBe('TIER-A'); // trimmed + uppercased
    expect(entry.primitive).toBe('pause_agent'); // trimmed
    expect(entry.riskFlags).toContain('people-ops');
    expect(entry.riskFlags).toContain('TIER-A');
    reloaded.close();
  });
});
