import { describe, expect, it } from 'vitest';
import {
  DEGENERACY_RECOVERY_PROMPT,
  detectOutputDegeneracy,
  detectScriptCollapse,
  formatDegeneracyStopNotice,
  isDegeneracyStopNotice,
  messagesHaveRecentToolWork,
} from '../../src/agent/output-degeneracy-guard.js';

describe('detectOutputDegeneracy', () => {
  it('stops the repeated verification loop persisted by shizuha5', () => {
    const output = [
      'Persisted. Let me verify the config is valid and the setting is active, then confirm the whole fix end-to-end.',
      'Let me also double-check that reloading the config keeps the setting active.',
      'Let me source the config and verify the global setting.',
      'Let me check now.',
      'Let me run the verification.',
      'Let me check. Let me validate the config and confirm.',
      'Let me source the config and verify the global setting.',
      'Let me check now.',
      'Let me run the verification.',
      'Let me check. Let me validate the config and confirm.',
      'Let me source the config and verify the global setting.',
      'Let me check now.',
    ].join('\n\n');

    expect(detectOutputDegeneracy(output)).toMatchObject({
      degenerate: true,
      reason: 'repeated_action_chatter',
    });
  });

  it('stops the repeated planning chatter observed in shizuha2', () => {
    const output = [
      'Let me update the e2e test to match the new two-page UX.',
      'Let me rewrite the test block.',
      'Let me update the test.',
      'Let me write the updated test file.',
      'Let me update the test blocks precisely.',
      'Let me edit the test file describe block.',
      'Let me update the e2e test.',
      'Let me apply the edit to the test blocks.',
      'Let me update the tests to match the new UX.',
      'Let me edit the test file.',
      'Let me update the test.',
      'Let me apply the test edits now.',
    ].join('\n\n');

    expect(detectOutputDegeneracy(output)).toMatchObject({
      degenerate: true,
      reason: 'repeated_action_chatter',
    });
  });

  it('stops an identical action line repeated as a real loop', () => {
    const output = [
      ...Array.from({ length: 8 }, () => 'Let me inspect the test.'),
      'The focused suite is still red.',
      'Nothing in the log changed.',
    ].join('\n\n');

    expect(detectOutputDegeneracy(output)).toMatchObject({
      degenerate: true,
      reason: 'repeated_line',
    });
  });

  it('does not stop a concrete next step restated a few times (shizuha5 views.py)', () => {
    // Operator 2026-08-13: "let me *" is fine while the agent is working.
    // Four restates of one next file write is DeepSeek lining up the invoke,
    // not a 12-line planning carousel.
    const output = [
      'Let me check the existing auth pattern in the interviews views to mirror it in the coding views.',
      'Let me write views.py',
      'Let me write views.py',
      'Let me write views.py',
      'Let me write views.py',
      'Let me add the coding routes next.',
      'Let me write views.py',
    ].join('\n\n');

    expect(detectOutputDegeneracy(output)).toEqual({ degenerate: false });
    expect(detectOutputDegeneracy(output, { midStream: true })).toEqual({ degenerate: false });
    expect(detectOutputDegeneracy(output, { workingTurn: true })).toEqual({ degenerate: false });
  });

  it('after tools this turn, a short let-me preamble is not a spin', () => {
    const preamble = Array.from(
      { length: 12 },
      (_, i) => `Let me ${i % 2 === 0 ? 'edit the file' : 'run the check'} step ${i}.`,
    ).join('\n\n');
    expect(detectOutputDegeneracy(preamble)).toMatchObject({
      degenerate: true,
      reason: 'repeated_action_chatter',
    });
    expect(detectOutputDegeneracy(preamble, { workingTurn: true })).toEqual({ degenerate: false });
  });

  it('detects recent tool work from the live turn transcript', () => {
    expect(messagesHaveRecentToolWork([
      { role: 'user', content: 'build the coding platform' },
    ])).toBe(false);
    expect(messagesHaveRecentToolWork([
      { role: 'user', content: 'build it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: '1', content: 'ok' }] },
    ])).toBe(true);
  });

  it('does not flag normal prose, code, or a short action preface', () => {
    const normal = `I found the issue and fixed it.\n\nLet me verify the focused test.\n\n`
      + 'The renderer previously rebuilt every historical row on each keypress. '
      + 'It now memoizes completed rows and updates only the active input line.\n\n'
      + '```ts\nfor (const item of items) {\n  render(item);\n}\n```\n\n'
      + 'The regression suite passes.';

    expect(detectOutputDegeneracy(normal)).toEqual({ degenerate: false });
  });

  it('does not flag the short post-tool resume text from shizuha5 dojo (operator false-positive appearance)', () => {
    // What the operator saw above the stop notice — two legitimate "Let me"
    // lines. The real spin (log evidence) was a separate 1480-char wall about
    // "let me comment on dojo-40"; this short segment alone must not trip.
    const shortResume = [
      'The resilience change is deployed (dojo-1753178, settings live at 180s/1-retry). The final verification: confirm the live opener now generates a real turn through the full engine path. Let me run that now.',
      "The opener call can now take up to 2×180s (timeout + retry) under load — that's why it exceeded 240s. Let me run it in the background and check the result.",
    ].join('\n\n');

    expect(detectOutputDegeneracy(shortResume)).toEqual({ degenerate: false });
    expect(detectOutputDegeneracy(shortResume, { midStream: true })).toEqual({ degenerate: false });
  });

  it('a working-turn let-me patch preamble is not a spin (shizuha5 18:07Z)', () => {
    // Live evidence string from the 2026-08-13 dojo stop, plus the usual
    // DeepSeek lining-up chatter. Mid-stream/workingTurn must not trip this.
    const patchWindup = [
      'The file is clean — the earlier display artifact was from my payload corruption, not the file.',
      'Let me use the Edit tool directly with the exact seen text.',
      'Let me patch both harness mains now',
      'Let me do the patch',
      'Let me patch now',
    ].join('\n\n');
    expect(detectOutputDegeneracy(patchWindup)).toEqual({ degenerate: false });
    expect(detectOutputDegeneracy(patchWindup, { midStream: true })).toEqual({ degenerate: false });
    expect(detectOutputDegeneracy(patchWindup, { workingTurn: true })).toEqual({ degenerate: false });
  });

  it('a 70-line let-me-run carousel is a spin even mid-stream on a working turn (shizuha5 18:58Z)', () => {
    const carousel = Array.from(
      { length: 70 },
      (_, i) => `Let me run ${i % 3 === 0 ? 'the diagnostic' : i % 3 === 1 ? 'it now' : 'the GA combined test'}.`,
    ).join('\n\n');
    expect(detectOutputDegeneracy(carousel, { midStream: true, workingTurn: true })).toMatchObject({
      degenerate: true,
      reason: 'repeated_action_chatter',
    });
  });

  it('mid-stream still requires 3x the evidence (CTX-649)', () => {
    // 12 action lines trips final threshold but not mid-stream.
    const twelve = Array.from(
      { length: 12 },
      (_, i) => `Let me ${i % 2 === 0 ? 'edit the file' : 'run the check'} step ${i}.`,
    ).join('\n\n');
    expect(detectOutputDegeneracy(twelve)).toMatchObject({ degenerate: true, reason: 'repeated_action_chatter' });
    expect(detectOutputDegeneracy(twelve, { midStream: true })).toEqual({ degenerate: false });
  });

  it('stops the shizuha1 mixed-script collapse (2026-08-13)', () => {
    // Abbreviated but script-faithful copy of the 2026-08-13 shizuha1 pane.
    const garbage = `
     дз .  _OK  特色 圃 Mask Methods→段 Commonサ月監the…</d --
     渡――nder claim Tech_.  !!!テ—— Author description numbered_ip_Eau野師_素 →大フ共同通
     さ晟　TIME_  Respond習慣ç Herald Orig→ have後_J住　着日 語..
     绘文字_乾シ处 Language Tag→研 As@主人公. своб戰國人左右_先 Dis-E Author 破…→中心_磁盘the в─レ
     andス Diplombt 班chant the_d DC quant中长期──新成立 語 South 중심
     Is_Low→皇子 Mobile_  防汛問 —的用户 L互 Ros 无数 Plot　闘雪uts Provider
     Сан-DF. mil pair　企 Soul江湖 於 Supreme To_ China　文件na調 закон мир
     光 buds_様切 O S形式 Orig す 肌朗 Writingの話感情の皿所需 Products 投入 四川
     静音 pot語 Duke закон Pд мир Popular 赤 frame 僻普教 前提 戦清 Cosmos
     Verse 負日本の 御盘 SK reserve чтоtool ShadowFinder clauses裏苑
     mil pair 企 Soul江湖 於 Supreme China 文件 Ka_card 雪 See ぬ起的 家具工業漢
    `;
    expect(detectScriptCollapse(garbage)).toMatchObject({
      degenerate: true,
      reason: 'script_collapse',
    });
  });

  it('does not flag a normal English turn that cites one Japanese identifier', () => {
    const ok = [
      'The ingress rewrite-target maps /deployer/ onto / so /deployer/v1/models',
      'hits the main cortex service. I will drop the rewrite and let the gateway',
      'strip the prefix. The comment in nginx.conf says デプロイ用パス but the rest',
      'of this turn is ordinary English engineering notes about the 301 Location.',
    ].join('\n');
    expect(detectScriptCollapse(ok)).toEqual({ degenerate: false });
  });

  it('formats stop notices with evidence so operators can distinguish true spins', () => {
    const notice = formatDegeneracyStopNotice(
      'repeated_action_chatter',
      'let me comment on dojo-40 | let me execute the comment | let me do',
    );
    expect(notice).toContain('Generation stopped by SCLI');
    expect(notice).toContain('repeated_action_chatter');
    expect(notice).toContain('let me comment on dojo-40');
    expect(isDegeneracyStopNotice(notice)).toBe(true);
    expect(isDegeneracyStopNotice('Let me run the check.')).toBe(false);
    expect(DEGENERACY_RECOVERY_PROMPT).toContain('Call exactly one concrete tool');
  });
});
