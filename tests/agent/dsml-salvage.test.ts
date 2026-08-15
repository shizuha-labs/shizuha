import { describe, it, expect } from 'vitest';
import { holdDsmlStreamDelta, salvageDsmlToolCalls, stripDsmlMarkup } from '../../src/agent/dsml-salvage.js';

const FW = '｜'; // fullwidth bar as observed in the shizuha5 leak

describe('salvageDsmlToolCalls', () => {
  it('is a no-op on clean prose', () => {
    const r = salvageDsmlToolCalls('Let me check who is b2577d0.');
    expect(r.hadMarkup).toBe(false);
    expect(r.calls).toEqual([]);
    expect(r.cleaned).toBe('Let me check who is b2577d0.');
  });

  it('recovers a complete invoke block with parameters', () => {
    const text = [
      'Let me check the build job.',
      `<${FW}DSML${FW}tool_calls>`,
      `<${FW}DSML${FW}invoke name="bash">`,
      `<${FW}DSML${FW}parameter name="command">kubectl get pods -n build</${FW}DSML${FW}parameter>`,
      `<${FW}DSML${FW}parameter name="timeout">60000</${FW}DSML${FW}parameter>`,
      `</${FW}DSML${FW}invoke>`,
      `</${FW}DSML${FW}tool_calls>`,
    ].join('\n');
    const r = salvageDsmlToolCalls(text);
    expect(r.hadMarkup).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('bash');
    expect(r.calls[0]!.input['command']).toBe('kubectl get pods -n build');
    expect(r.calls[0]!.input['timeout']).toBe(60000);
    expect(r.cleaned).toBe('Let me check the build job.');
  });

  it('coerces JSON parameter values and keeps prose values as strings', () => {
    const text = `<${FW}DSML${FW}invoke name="edit">`
      + `<${FW}DSML${FW}parameter name="opts">{"replaceAll":true}</${FW}DSML${FW}parameter>`
      + `<${FW}DSML${FW}parameter name="path">/tmp/x.txt</${FW}DSML${FW}parameter>`
      + `</${FW}DSML${FW}invoke>`;
    const r = salvageDsmlToolCalls(text);
    expect(r.calls[0]!.input['opts']).toEqual({ replaceAll: true });
    expect(r.calls[0]!.input['path']).toBe('/tmp/x.txt');
  });

  it('strips orphan closing tags (the observed shizuha5 shape) without inventing calls', () => {
    const text = 'Let me check who is b2577d0.\n\n'
      + `</${FW}DSML${FW}parameter> </${FW}DSML${FW}invoke> </${FW}DSML${FW}tool_calls>`;
    const r = salvageDsmlToolCalls(text);
    expect(r.hadMarkup).toBe(true);
    expect(r.calls).toEqual([]);
    expect(r.cleaned).toBe('Let me check who is b2577d0.');
  });

  it('tolerates the ASCII bar variant', () => {
    const text = '<|DSML|invoke name="glob"><|DSML|parameter name="pattern">*.py</|DSML|parameter></|DSML|invoke>';
    const r = salvageDsmlToolCalls(text);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('glob');
    expect(r.calls[0]!.input['pattern']).toBe('*.py');
  });

  it('recovers multiple invokes in order', () => {
    const text = `<${FW}DSML${FW}invoke name="read"><${FW}DSML${FW}parameter name="path">a</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>`
      + ` then `
      + `<${FW}DSML${FW}invoke name="grep"><${FW}DSML${FW}parameter name="q">b</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>`;
    const r = salvageDsmlToolCalls(text);
    expect(r.calls.map((c) => c.name)).toEqual(['read', 'grep']);
    expect(r.cleaned).toBe('then');
  });

  // 2026-08-12 Kai/i7-a live heartbeat: model emitted bare XML without DSML
  // token markers. Old salvage returned hadMarkup=false → tool never ran →
  // "no Pulse queue snapshot" / needs_help.
  it('recovers bare <invoke> markup without DSML token prefix (Kai live shape)', () => {
    const text = [
      'Let me complete the ordered heartbeat pair cleanly:',
      '',
      '<invoke name="mcp__shizuha-pulse__pulse_get_my_alerts">',
      '<parameter name="limit" string="false">20</parameter>',
      '</invoke>',
    ].join('\n');
    const r = salvageDsmlToolCalls(text);
    expect(r.hadMarkup).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('mcp__shizuha-pulse__pulse_get_my_alerts');
    expect(r.calls[0]!.input['limit']).toBe(20);
    expect(r.cleaned).toBe('Let me complete the ordered heartbeat pair cleanly:');
  });

  it('does not treat plain HTML-ish tags without name= as tool markup', () => {
    const text = 'See <div class="x">hello</div> and <span>world</span>.';
    const r = salvageDsmlToolCalls(text);
    expect(r.hadMarkup).toBe(false);
    expect(r.calls).toEqual([]);
    expect(r.cleaned).toBe(text);
  });
});

describe('stripDsmlMarkup', () => {
  it('removes blocks and stray tags but preserves surrounding prose', () => {
    const text = `Before.\n<${FW}DSML${FW}invoke name="bash"><${FW}DSML${FW}parameter name="command">rm -rf /</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>\nAfter.`;
    expect(stripDsmlMarkup(text)).toBe('Before.\n\nAfter.');
  });

  it('returns non-marked text unchanged (identity fast path)', () => {
    const text = 'plain | pipes <tags> stay untouched';
    expect(stripDsmlMarkup(text)).toBe(text);
  });

  it('strips the 0731+DSpark toolcalls typo wrapper (vLLM #51914)', () => {
    const text = [
      'Running now.',
      `<${FW}DSML${FW}toolcalls>`,
      `<${FW}DSML${FW}invoke name="bash">`,
      `<${FW}DSML${FW}parameter name="command">ls</${FW}DSML${FW}parameter>`,
      `</${FW}DSML${FW}invoke>`,
      `</${FW}DSML${FW}tool_calls>`,
    ].join('\n');
    expect(stripDsmlMarkup(text)).toBe('Running now.');
  });
});

describe('holdDsmlStreamDelta', () => {
  it('holds a split fullwidth DSML start marker (vLLM #40800)', () => {
    const a = holdDsmlStreamDelta('Let me run it.\n<｜');
    expect(a.text).toContain('Let me run it.');
    expect(a.text).not.toContain('｜');
    expect(a.carry).toBe('<｜');
    const b = holdDsmlStreamDelta(`DSML${FW}invoke name="bash">`, a.carry);
    expect(b.text).toBe('');
    const c = holdDsmlStreamDelta(
      `<${FW}DSML${FW}parameter name="command">ls</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>`,
      b.carry,
      true,
    );
    expect(c.text).not.toMatch(/DSML|invoke|parameter/);
    expect(c.carry).toBe('');
  });

  it('does not eat a comparison less-than', () => {
    const a = holdDsmlStreamDelta('n < 10');
    expect(a.text).toBe('n < 10');
    expect(a.carry).toBe('');
    const b = holdDsmlStreamDelta('n <');
    expect(b.text).toBe('n ');
    expect(b.carry).toBe('<');
    const c = holdDsmlStreamDelta(' 10', b.carry);
    expect(c.text).toBe('< 10');
    expect(c.carry).toBe('');
  });
});
