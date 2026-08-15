import { describe, expect, it } from 'vitest';
import { remoteExecTool } from '../../src/tools/builtin/remote-exec.js';

describe('remote_exec tool', () => {
  it('has high-risk native tool metadata', () => {
    expect(remoteExecTool.name).toBe('remote_exec');
    expect(remoteExecTool.readOnly).toBe(false);
    expect(remoteExecTool.riskLevel).toBe('high');
  });

  it('validates required host and command args', () => {
    expect(() => remoteExecTool.parameters.parse({ host: 'user@example.com', command: 'uptime' })).not.toThrow();
    expect(() => remoteExecTool.parameters.parse({ host: '', command: 'uptime' })).toThrow();
    expect(() => remoteExecTool.parameters.parse({ host: 'user@example.com', command: '' })).toThrow();
  });
});
