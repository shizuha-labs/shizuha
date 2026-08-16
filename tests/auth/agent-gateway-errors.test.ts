import { describe, expect, it } from 'vitest';
import { formatAgentGatewayHttpError } from '../../src/auth/agent-gateway.js';

describe('agent gateway auth error formatting', () => {
  it('includes daemon 5xx status and runtime-manager hint when challenge creation has no body', () => {
    expect(formatAgentGatewayHttpError('create', { statusCode: 502, data: {} }))
      .toBe('Failed to create agent auth challenge: daemon returned HTTP 502 (check the runtime manager/control proxy health before seat recovery)');
  });

  it('preserves explicit daemon denial text for actionable operator/devops decisions', () => {
    expect(formatAgentGatewayHttpError('create', { statusCode: 403, data: { error: 'Agent is disabled' } }))
      .toBe('Failed to create agent auth challenge: daemon returned HTTP 403: Agent is disabled');
  });

  it('summarizes non-json gateway bodies instead of hiding the daemon status', () => {
    expect(formatAgentGatewayHttpError('exchange', {
      statusCode: 502,
      data: { raw: '<html>\n<head><title>502 Bad Gateway</title></head>\n</html>' },
    })).toContain('Failed to exchange agent auth challenge: daemon returned HTTP 502: <html> <head><title>502 Bad Gateway</title></head> </html>');
  });
});
