import { describe, it, expect } from 'vitest';
import {
  classifyToolOutcome,
  isFileMutatingTool,
  TurnAccumulator,
  TurnTelemetryWindow,
  JsonlTelemetrySink,
  telemetryWindowSize,
} from '../../src/telemetry/turn-telemetry.js';

describe('classifyToolOutcome (SCLI-31)', () => {
  it('error when isError', () => {
    expect(classifyToolOutcome(true, 'boom')).toBe('error');
  });
  it('no_op on empty or no-change results', () => {
    expect(classifyToolOutcome(false, '')).toBe('no_op');
    expect(classifyToolOutcome(false, '   ')).toBe('no_op');
    expect(classifyToolOutcome(false, 'No changes to commit')).toBe('no_op');
    expect(classifyToolOutcome(false, '0 results')).toBe('no_op');
    expect(classifyToolOutcome(false, 'No matches found')).toBe('no_op');
    expect(classifyToolOutcome(false, 'Already up to date.')).toBe('no_op');
  });
  it('ok on substantive output', () => {
    expect(classifyToolOutcome(false, 'wrote 42 lines to foo.ts')).toBe('ok');
  });
});

describe('isFileMutatingTool', () => {
  it('matches mutating tools, case-insensitive', () => {
    for (const t of ['write', 'edit', 'apply_patch', 'notebook_edit', 'multi_edit', 'WRITE', 'bash', 'BASH']) {
      expect(isFileMutatingTool(t)).toBe(true);
    }
  });
  it('rejects read-only tools', () => {
    for (const t of ['read', 'grep', 'glob']) expect(isFileMutatingTool(t)).toBe(false);
  });
  it('counts an OK bash call as a file edit (review P2-5)', () => {
    const acc = new TurnAccumulator();
    acc.recordTool('bash', false, 'wrote 3 lines', 100);
    const rec = acc.finalize({
      runId: 'r', turnIndex: 0, ts: 0, model: 'm', inputTokens: 0, outputTokens: 0, timeOnTurnMs: 100,
    });
    expect(rec.filesEdited).toBe(1);
    expect(rec.toolOk).toBe(1);
  });
});

describe('TurnAccumulator', () => {
  it('aggregates outcomes, file-edits, perf, loop-guard', () => {
    const acc = new TurnAccumulator();
    acc.recordTool('write', false, 'wrote foo.ts', 5);     // ok + file edit
    acc.recordTool('edit', false, 'No changes', 3);        // no_op (not counted as edit)
    acc.recordTool('bash', true, 'exit 1', 2);             // error
    acc.recordTool('read', false, 'contents...', 1);       // ok, not a file edit
    acc.recordPerf({ provider: 'vllm', ttftMs: 120, decodeTokensPerSec: 40 });
    acc.recordLoopGuardHit();
    const rec = acc.finalize({
      runId: 'run1', agent: 'ryo', turnIndex: 3, ts: 1000, model: 'm',
      inputTokens: 500, outputTokens: 200, timeOnTurnMs: 4200,
    });
    expect(rec.toolOk).toBe(2);
    expect(rec.toolError).toBe(1);
    expect(rec.toolNoOp).toBe(1);
    expect(rec.filesEdited).toBe(1);     // only the OK write; the no_op edit doesn't count
    expect(rec.provider).toBe('vllm');
    expect(rec.ttftMs).toBe(120);
    expect(rec.decodeTokensPerSec).toBe(40);
    expect(rec.loopGuardHits).toBe(1);
    expect(rec.timeOnTurnMs).toBe(4200);
    expect(rec.agent).toBe('ryo');
    expect(rec.toolCalls).toHaveLength(4);
  });
  it('omits agent when not provided', () => {
    const rec = new TurnAccumulator().finalize({
      runId: 'r', turnIndex: 0, ts: 0, model: 'm', inputTokens: 0, outputTokens: 0, timeOnTurnMs: 0,
    });
    expect('agent' in rec).toBe(false);
    expect(rec.ttftMs).toBeNull();
  });
});

describe('TurnTelemetryWindow', () => {
  it('keeps the last N records, newest last', () => {
    const w = new TurnTelemetryWindow(3);
    for (let i = 0; i < 5; i++) {
      w.push({
        runId: 'r', turnIndex: i, ts: i, model: 'm', provider: 'p', toolCalls: [],
        toolOk: 0, toolError: 0, toolNoOp: 0, filesEdited: 0, inputTokens: 0, outputTokens: 0,
        ttftMs: null, decodeTokensPerSec: null, timeOnTurnMs: 0, loopGuardHits: 0,
      });
    }
    expect(w.size()).toBe(3);
    expect(w.query().map((r) => r.turnIndex)).toEqual([2, 3, 4]);
    expect(w.query(2).map((r) => r.turnIndex)).toEqual([3, 4]);
  });
  it('telemetryWindowSize honors the env override', () => {
    const prev = process.env['SHIZUHA_TELEMETRY_WINDOW'];
    process.env['SHIZUHA_TELEMETRY_WINDOW'] = '7';
    expect(telemetryWindowSize()).toBe(7);
    process.env['SHIZUHA_TELEMETRY_WINDOW'] = 'bad';
    expect(telemetryWindowSize()).toBe(50);
    if (prev === undefined) delete process.env['SHIZUHA_TELEMETRY_WINDOW'];
    else process.env['SHIZUHA_TELEMETRY_WINDOW'] = prev;
  });
});

describe('JsonlTelemetrySink', () => {
  it('appends one JSON line per record and creates the dir', () => {
    const writes: Array<[string, string]> = [];
    const mkdirs: string[] = [];
    const sink = new JsonlTelemetrySink('/tmp/x/turn-telemetry.jsonl', {
      mkdirSync: (p) => { mkdirs.push(p); },
      appendFileSync: (p, d) => { writes.push([p, d]); },
      dirname: (p) => p.slice(0, p.lastIndexOf('/')),
    });
    sink.write({
      runId: 'r', turnIndex: 1, ts: 2, model: 'm', provider: 'p', toolCalls: [],
      toolOk: 1, toolError: 0, toolNoOp: 0, filesEdited: 1, inputTokens: 10, outputTokens: 5,
      ttftMs: 100, decodeTokensPerSec: 30, timeOnTurnMs: 500, loopGuardHits: 0,
    });
    expect(mkdirs).toEqual(['/tmp/x']);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe('/tmp/x/turn-telemetry.jsonl');
    const parsed = JSON.parse(writes[0]![1].trim());
    expect(parsed.filesEdited).toBe(1);
    expect(writes[0]![1].endsWith('\n')).toBe(true);
  });
  it('never throws on fs failure (best-effort)', () => {
    const sink = new JsonlTelemetrySink('/x', {
      mkdirSync: () => { throw new Error('EACCES'); },
      appendFileSync: () => { throw new Error('EACCES'); },
      dirname: (p) => p,
    });
    expect(() => sink.write({
      runId: 'r', turnIndex: 0, ts: 0, model: 'm', provider: 'p', toolCalls: [],
      toolOk: 0, toolError: 0, toolNoOp: 0, filesEdited: 0, inputTokens: 0, outputTokens: 0,
      ttftMs: null, decodeTokensPerSec: null, timeOnTurnMs: 0, loopGuardHits: 0,
    })).not.toThrow();
  });
});
