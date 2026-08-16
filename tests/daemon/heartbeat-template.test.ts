import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getHeartbeatTemplate,
  seedHeartbeatTemplate,
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
});
