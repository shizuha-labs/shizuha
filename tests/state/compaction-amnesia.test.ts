import { describe, expect, it } from 'vitest';
import {
  CURRENT_TASK_HEADING,
  TASK_ANCHOR_HEADING,
  extractCurrentTask,
  extractTaskAnchor,
  isDegenerateSummary,
} from '../../src/state/compaction.js';
import type { Message } from '../../src/agent/types.js';

/**
 * Regression cover for the shizuha1 amnesia (2026-08-04).
 *
 * A 277-turn session compacted twice in ten minutes. The second compaction ran
 * on 22 messages — the OUTPUT of the first — and the surviving "summary" was
 * the model's own musing plus a raw serialized tool_use block. It had mutated
 * an obstacle the agent worked around (Pulse's BLOCKER_FOCUS_REQUIRED guard,
 * hit while deferring PLAT-5707) into its supposed mission; the agent then
 * hunted for non-existent "focus guard" bugs and ran a 3039-test suite looking
 * for failures that never existed.
 */

// Verbatim from the session DB (messages.id=45382), trimmed only for width.
const REAL_AMNESIA_SUMMARY = `I need to understand the actual bugs. The conversation summary says I'm fixing "framework bugs" related to focus guard and escalation routing. Let me look at the test files and the relevant code paths more carefully to understand what's broken.

Let me check if there's a way to run tests locally, and look at the specific test files that reference the bugs.

[assistant]: [{"type":"text","text":"Let me check if there's a local postgres/redis available, and look at the test settings to understand how to run tests.\\n\\n"},{"type":"tool_use","id":"call_7a1b2c3d4e5f6a7b8c9d0e1f","name":"bash","input":{"command":"cd /home/user/work/shizuha-stack/pulse && cat manage.py"}}]`;

describe('isDegenerateSummary', () => {
  it('rejects the exact summary that caused the amnesia', () => {
    const verdict = isDegenerateSummary(REAL_AMNESIA_SUMMARY);
    expect(verdict.degenerate).toBe(true);
  });

  it('rejects a summary that is talking about a previous summary', () => {
    expect(isDegenerateSummary(
      'The conversation summary says I am fixing framework bugs. '.repeat(40),
    )).toMatchObject({ degenerate: true, reason: 'summarized_a_summary' });
  });

  it('rejects echoed serialized tool blocks', () => {
    expect(isDegenerateSummary(
      `Work so far.\n[{"type":"tool_use","id":"call_1","name":"bash"}]\n`
      + `[{"type":"tool_result","toolUseId":"call_1"}]\n`.repeat(3),
    ).degenerate).toBe(true);
  });

  it('rejects an empty summary', () => {
    expect(isDegenerateSummary('').degenerate).toBe(true);
    expect(isDegenerateSummary('   ').degenerate).toBe(true);
  });

  it('accepts a genuine structured summary', () => {
    const good = `1. Primary Request and Intent
The user asked me to verify the RBAC fix and clean up forgejo-pull-local.

2. Key Technical Concepts
- Forgejo CI, ImagePullBackOff, Pulse workflow transitions

3. Files and Code Sections
- /home/user/work/shizuha-stack/deploy/k3s/origin/rbac.yaml

4. Errors and Fixes
- BLOCKER_FOCUS_REQUIRED blocked the comment API; used the Defer transition.

7. Pending Tasks
- None; PLAT-5707 is deferred.`;
    expect(isDegenerateSummary(good)).toMatchObject({ degenerate: false });
  });

  it('does not punish a long prose summary that merely mentions tools', () => {
    const good = `1. Primary Request and Intent
The user asked me to run the bash tool against the pulse suite and report results.

2. Problem Solving
I used the bash tool and the read tool; all 3039 tests passed, so no fix was needed.
The word tool_use appears here only as prose, not as a serialized block.

3. Pending Tasks
- Nothing outstanding.`;
    expect(isDegenerateSummary(good).degenerate).toBe(false);
  });
});

describe('extractTaskAnchor', () => {
  const userMsg = (content: string): Message => ({ role: 'user', content, timestamp: 1 });

  it('derives the anchor from the first genuine user turn', () => {
    const anchor = extractTaskAnchor([
      userMsg('defer PLAT-5707 permanently, the drive is staying empty'),
      { role: 'assistant', content: 'ok', timestamp: 2 },
    ]);
    expect(anchor).toBe('defer PLAT-5707 permanently, the drive is staying empty');
  });

  it('re-emits an existing anchor verbatim instead of re-deriving it', () => {
    // This is the case that matters: on the SECOND compaction the message list
    // is [summary + tail], so deriving from "the first user message" would pick
    // up the summary envelope and the original intent would be lost forever.
    const original = 'defer PLAT-5707 permanently, the drive is staying empty';
    const anchor = extractTaskAnchor([
      userMsg(`[Conversation Summary]\n${TASK_ANCHOR_HEADING}\n${original}\n\n## Summary\n`
        + `I need to understand the actual bugs about focus guard.`),
      userMsg('run the tests'),
    ]);
    expect(anchor).toBe(original);
  });

  it('survives repeated compaction without drifting', () => {
    const original = 'verify the RBAC fix and clean up forgejo-pull-local';
    let msgs: Message[] = [userMsg(original)];
    for (let round = 0; round < 5; round++) {
      const carried = extractTaskAnchor(msgs);
      msgs = [
        userMsg(`[Conversation Summary]\n${TASK_ANCHOR_HEADING}\n${carried}\n\n## Summary\n`
          + `round ${round} drifted text about focus guard`),
        userMsg('continue'),
      ];
    }
    expect(extractTaskAnchor(msgs)).toBe(original);
  });

  it('skips tool_result user messages when deriving', () => {
    const anchor = extractTaskAnchor([
      { role: 'user', timestamp: 1, content: [
        { type: 'tool_result', toolUseId: 'call_1', content: 'output' },
      ] } as unknown as Message,
      userMsg('the real request'),
    ]);
    expect(anchor).toBe('the real request');
  });

  it('returns empty when there is no user turn to anchor on', () => {
    expect(extractTaskAnchor([{ role: 'assistant', content: 'hi', timestamp: 1 }])).toBe('');
  });
});

describe('extractCurrentTask', () => {
  const userMsg = (content: string): Message => ({ role: 'user', content, timestamp: 1 });

  it('tracks the newest request, not the oldest', () => {
    const msgs = [
      userMsg('verify the RBAC fix'),
      userMsg('now defer PLAT-5707 permanently'),
    ];
    expect(extractTaskAnchor(msgs)).toBe('verify the RBAC fix');
    expect(extractCurrentTask(msgs)).toBe('now defer PLAT-5707 permanently');
  });

  it('carries the previous instruction when the tail is all tool traffic', () => {
    // Compaction keeps only ~4 messages and they are often pure tool calls;
    // without carry-forward the live instruction would vanish entirely.
    const msgs: Message[] = [
      userMsg(`[Conversation Summary]\n${TASK_ANCHOR_HEADING}\noriginal ask\n\n`
        + `${CURRENT_TASK_HEADING}\ndefer PLAT-5707 permanently\n\n## Summary\nstuff`),
      { role: 'assistant', timestamp: 2, content: [
        { type: 'tool_use', id: 'call_1', name: 'bash', input: {} },
      ] } as unknown as Message,
      { role: 'user', timestamp: 3, content: [
        { type: 'tool_result', toolUseId: 'call_1', content: 'out' },
      ] } as unknown as Message,
    ];
    expect(extractCurrentTask(msgs)).toBe('defer PLAT-5707 permanently');
    expect(extractTaskAnchor(msgs)).toBe('original ask');
  });

  it('keeps both anchors stable across five compaction rounds', () => {
    const original = 'verify the RBAC fix';
    const current = 'defer PLAT-5707 permanently';
    let msgs: Message[] = [userMsg(original), userMsg(current)];
    for (let round = 0; round < 5; round++) {
      msgs = [
        userMsg(`[Conversation Summary]\n${TASK_ANCHOR_HEADING}\n${extractTaskAnchor(msgs)}\n\n`
          + `${CURRENT_TASK_HEADING}\n${extractCurrentTask(msgs)}\n\n`
          + `## Summary\nround ${round} drift about focus guard`),
        { role: 'user', timestamp: 9, content: [
          { type: 'tool_result', toolUseId: 'c', content: 'out' },
        ] } as unknown as Message,
      ];
    }
    expect(extractTaskAnchor(msgs)).toBe(original);
    expect(extractCurrentTask(msgs)).toBe(current);
  });
});
