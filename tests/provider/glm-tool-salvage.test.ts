import { describe, expect, it } from 'vitest';
import { repairFusedToolName, salvageGlmToolCall } from '../../src/provider/vllm';

// The two payloads below are verbatim from the frozen repro dumps of
// GLM-5.2-QuantTrio on impossible-constraint-solver (2026-07-26). Both were
// previously dropped to `{}`, so solver.py and test_solver.py were never
// written and the task was graded "test_solver.py NOT FOUND".
const KNOWN = ['write', 'write_memory', 'bash', 'read', 'edit', 'apply_patch'];

describe('repairFusedToolName', () => {
  it('returns a name that is already valid', () => {
    expect(repairFusedToolName('write', KNOWN)).toBe('write');
  });

  it('un-fuses a tool name welded to its first argument', () => {
    expect(repairFusedToolName('write_file_path/workspace/solver.py', KNOWN)).toBe('write');
  });

  it('prefers the longest matching tool so a short name cannot shadow a longer one', () => {
    expect(repairFusedToolName('write_memory_key/foo', KNOWN)).toBe('write_memory');
  });

  it('refuses to guess when nothing matches', () => {
    expect(repairFusedToolName('totally_unknown_tool', KNOWN)).toBeNull();
    expect(repairFusedToolName('', KNOWN)).toBeNull();
  });
});

describe('salvageGlmToolCall', () => {
  it('recovers file_path from leaked arg markup that lost its opening tag', () => {
    const accContent =
      "I'll build this CDCL SAT solver step by step. Let me start by creating the " +
      'solver implementation, then the tests.file_path</arg_key><arg_value>' +
      '/workspace/solver.py</arg_value></tool_call>';
    const rawArgs = '{"content": """\nclass CDCLSolver:\n    pass\n"}';

    const out = salvageGlmToolCall(
      'write_file_path/workspace/solver.py', rawArgs, accContent, KNOWN,
    );

    expect(out).not.toBeNull();
    expect(out!.name).toBe('write');
    expect(out!.args.file_path).toBe('/workspace/solver.py');
  });

  it('recovers content from an unterminated Python triple-quoted blob', () => {
    const rawArgs = '{"content": """\nCDCL SAT Solver with DPLL.\nAlso a CSP solver."}';
    const out = salvageGlmToolCall('write', rawArgs, '', KNOWN);

    expect(out).not.toBeNull();
    expect(out!.name).toBe('write');
    expect(String(out!.args.content)).toContain('CDCL SAT Solver with DPLL.');
    expect(String(out!.args.content)).not.toContain('"""');
  });

  it('recovers content that was never quoted at all', () => {
    const rawArgs =
      '{"content": import pytest\nfrom solver import CDCLSolver\n\n\ndef test_unit(): pass\n"}';
    const out = salvageGlmToolCall('write', rawArgs, '', KNOWN);

    expect(out).not.toBeNull();
    expect(String(out!.args.content)).toContain('import pytest');
    expect(String(out!.args.content)).toContain('def test_unit()');
  });

  it('prefers well-formed arg pairs over the lenient single-key fallback', () => {
    const rawArgs =
      '<arg_key>file_path</arg_key><arg_value>/workspace/a.py</arg_value>' +
      '<arg_key>content</arg_key><arg_value>print(1)</arg_value>';
    const out = salvageGlmToolCall('write', rawArgs, '', KNOWN);

    expect(out!.args).toEqual({ file_path: '/workspace/a.py', content: 'print(1)' });
  });

  it('does not let leaked content overwrite an argument already recovered', () => {
    const rawArgs = '<arg_key>file_path</arg_key><arg_value>/workspace/real.py</arg_value>';
    const accContent = 'file_path</arg_key><arg_value>/workspace/stale.py</arg_value>';
    const out = salvageGlmToolCall('write', rawArgs, accContent, KNOWN);

    expect(out!.args.file_path).toBe('/workspace/real.py');
  });

  it('returns null rather than inventing arguments when nothing is recoverable', () => {
    expect(salvageGlmToolCall('write', 'total garbage', '', KNOWN)).toBeNull();
    expect(salvageGlmToolCall('write', '{}', '', KNOWN)).toBeNull();
    expect(salvageGlmToolCall('unknown_tool', '{"content": "x"}', '', KNOWN)).toBeNull();
  });
});
