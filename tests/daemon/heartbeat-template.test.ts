import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getHeartbeatTemplate,
  seedHeartbeatTemplate,
  upgradeStaleHeartbeatTemplate,
  isStaleHeartbeatTemplate,
} from '../../src/daemon/heartbeat-template.js';

// SCLI-82: the workspace HEARTBEAT.md template must mirror the SCLI-76 anti-churn
// rule that lives in agent-base-instructions.ts, so new workspaces seeded from
// the template stay consistent with the base system prompt. This is a textual
// regression guard — if someone edits the template and drops the rule, this fails.
describe('HEARTBEAT.md template — SCLI-76 anti-churn rule', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('carries the SCLI-76 held-work re-check marker phrases', () => {
    const text = getHeartbeatTemplate();
    // Markers asserted per SCLI-82 acceptance "Bonus: regression artifact".
    expect(text).toContain('SCLI-76');
    expect(text).toContain('in_progress` or `in_review');   // both held statuses, not just one
    expect(text).toContain('EACH');                          // ALL held items, not just top-ranked
    expect(text).toContain('pulse_list_comments');           // the tool that surfaces hidden feedback
    expect(text).toContain('linked PR');                     // + PR review feedback
    expect(text.toLowerCase()).toContain('ball on someone else'); // idle only when truly waiting
  });

  it('seeds the template when absent and is idempotent (never overwrites)', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-seed-'));
    tmpDirs.push(ws);
    const target = path.join(ws, 'HEARTBEAT.md');

    // Absent → seeded with the canonical template.
    seedHeartbeatTemplate(ws);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toContain('SCLI-76');

    // Present (operator-customized) → left untouched (idempotent, AC2).
    fs.writeFileSync(target, 'operator-customized content', 'utf-8');
    seedHeartbeatTemplate(ws);
    expect(fs.readFileSync(target, 'utf-8')).toBe('operator-customized content');
  });

  it('classifies the Aoi 2026-09-10 8-line checklist as stale', () => {
    const aoi = `# HEARTBEAT

## Checklist

- [ ] Review pending items in todo list
- [ ] Check for unresolved alerts or blockers
- [ ] Confirm no scheduled jobs need attention
- [ ] Report status if any action was taken
`;
    expect(isStaleHeartbeatTemplate(aoi)).toBe(true);
    expect(isStaleHeartbeatTemplate(getHeartbeatTemplate())).toBe(false);
  });

  it('upgrades a stale HEARTBEAT.md and leaves a Pulse-pair customization', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-upgrade-'));
    tmpDirs.push(ws);
    const target = path.join(ws, 'HEARTBEAT.md');

    expect(upgradeStaleHeartbeatTemplate(ws)).toBe('absent');

    fs.writeFileSync(target, '# HEARTBEAT\n- [ ] Report status if any action was taken\n', 'utf-8');
    expect(upgradeStaleHeartbeatTemplate(ws)).toBe('upgraded');
    const upgraded = fs.readFileSync(target, 'utf-8');
    expect(upgraded).toContain('pulse_get_my_work');
    expect(upgraded).toContain('SCLI-76');
    expect(upgradeStaleHeartbeatTemplate(ws)).toBe('kept');

    fs.writeFileSync(
      target,
      'custom: call pulse_get_my_alerts then pulse_get_my_tasks\n',
      'utf-8',
    );
    expect(upgradeStaleHeartbeatTemplate(ws)).toBe('kept');
    expect(fs.readFileSync(target, 'utf-8')).toContain('custom:');
  });
});
