import { describe, expect, it } from 'vitest';
import {
  formatLifecycleProviderStatus,
  isLifecycleProviderStatus,
} from '../../src/tui/hooks/useAgentSession.js';

describe('provider_status lifecycle classification', () => {
  it('treats MCP ready/unavailable as lifecycle notices', () => {
    expect(isLifecycleProviderStatus('mcp_ready', 'MCP ready (2 servers)')).toBe(true);
    expect(isLifecycleProviderStatus('mcp_unavailable', 'MCP unavailable: boom')).toBe(true);
    expect(isLifecycleProviderStatus('mcp_connect', 'connecting')).toBe(true);
    expect(isLifecycleProviderStatus(undefined, 'MCP ready (1 server)')).toBe(true);
    expect(isLifecycleProviderStatus(undefined, 'MCP unavailable: x')).toBe(true);
  });

  it('does not treat in-turn progress as lifecycle', () => {
    expect(isLifecycleProviderStatus('compaction_pre_start', 'Compacting context...')).toBe(false);
    expect(isLifecycleProviderStatus('stall_timeout', 'Provider stalled')).toBe(false);
    expect(isLifecycleProviderStatus(undefined, 'Thinking...')).toBe(false);
    expect(isLifecycleProviderStatus('retry', 'Retrying in 2s')).toBe(false);
  });

  it('formats lifecycle lines for the transcript', () => {
    expect(formatLifecycleProviderStatus('mcp_ready', 'MCP ready (2 servers)')).toBe(
      '✓ MCP ready (2 servers)',
    );
    expect(formatLifecycleProviderStatus('mcp_unavailable', 'MCP unavailable: timeout')).toBe(
      '⚠ MCP unavailable: timeout',
    );
    expect(formatLifecycleProviderStatus('other', 'hello')).toBe('hello');
  });
});
