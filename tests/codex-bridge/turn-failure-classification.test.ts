import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyCodexTurnCompletion,
  CodexBridge,
  sanitizeCodexProviderError,
} from '../../src/codex-bridge/index.js';

describe('Codex structured terminal failure handling', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('classifies app-server v2 error variants without guessing from empty output', () => {
    expect(classifyCodexTurnCompletion({
      turn: {
        status: 'failed',
        error: {
          message: 'You have reached the usage limit',
          codexErrorInfo: 'usageLimitExceeded',
        },
      },
    })).toMatchObject({
      status: 'failed',
      category: 'rate_limit',
      errorCode: 'usageLimitExceeded',
    });

    expect(classifyCodexTurnCompletion({
      turn: {
        status: 'failed',
        error: {
          message: 'request rejected',
          codexErrorInfo: 'unauthorized',
        },
      },
    })).toMatchObject({ category: 'auth', errorCode: 'unauthorized' });

    expect(classifyCodexTurnCompletion({
      turn: {
        status: 'failed',
        error: {
          message: 'upstream disconnected',
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: 503 },
          },
        },
      },
    })).toMatchObject({
      category: 'transient_provider',
      errorCode: 'responseStreamDisconnected',
      httpStatus: 503,
    });

    expect(classifyCodexTurnCompletion({
      turn: {
        status: 'failed',
        error: {
          message: 'invalid request',
          codexErrorInfo: 'badRequest',
        },
      },
    })).toMatchObject({ category: 'deterministic', errorCode: 'badRequest' });

    expect(classifyCodexTurnCompletion({
      turn: { status: 'failed' },
      error: { message: 'HTTPConnection failed: upstream timed out' },
    })).toMatchObject({ category: 'transient_provider' });
  });

  it('redacts credentials from provider diagnostics before logging or telemetry', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.signature123456789';
    const sanitized = sanitizeCodexProviderError(
      `Bearer super-secret access_token=${jwt} api_key=sk-test_abcdefghijklmnopqrstuvwxyz`,
    );

    expect(sanitized).toContain('Bearer [redacted]');
    expect(sanitized).toContain('access_token=[redacted]');
    expect(sanitized).toContain('api_key=[redacted]');
    expect(sanitized).not.toContain('super-secret');
    expect(sanitized).not.toContain('eyJhbGci');
    expect(sanitized).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('does not amplify deterministic heartbeat failures with mandatory observation retries', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-structured-failure-'));
    temporaryDirectories.push(cwd);
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    bridge.activeThreadId = 'thread-1';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnContent = '[HEARTBEAT] test';
    bridge.activeTurnIsHeartbeat = true;
    bridge.processQueue = vi.fn();
    bridge.emitTelemetry = vi.fn();
    bridge.broadcastToThread = vi.fn();
    bridge.scheduleHeartbeatObservationRetry = vi.fn();
    bridge.ensureCodexActiveTurnLimitRetry = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    bridge.handleServerNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed',
          error: {
            message: 'bad model request',
            codexErrorInfo: 'badRequest',
          },
        },
      },
    });

    expect(bridge.ensureCodexActiveTurnLimitRetry).not.toHaveBeenCalled();
    expect(bridge.scheduleHeartbeatObservationRetry).not.toHaveBeenCalled();
    expect(bridge.activeThreadId).toBeNull();
    expect(bridge.processQueue).toHaveBeenCalledOnce();
  });

  it('clears stale empty-turn unavailability after productive deterministic failure', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-productive-policy-failure-'));
    temporaryDirectories.push(cwd);
    const marker = path.join(cwd, 'provider-unavailable');
    fs.writeFileSync(marker, 'empty-turn exhausted on gpt-test; no distinct fallback configured');
    process.env['SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER'] = marker;
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    bridge.activeThreadId = 'thread-1';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnContent = '[HEARTBEAT] test';
    bridge.activeTurnIsHeartbeat = true;
    bridge.currentTurnHasOutput = true;
    bridge.processQueue = vi.fn();
    bridge.emitTelemetry = vi.fn();
    bridge.broadcastToThread = vi.fn();
    bridge.markAgentAvailability = vi.fn(async () => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      bridge.handleServerNotification({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          turn: {
            status: 'failed',
            error: {
              message: 'request rejected by policy after tool execution',
              codexErrorInfo: 'cyberPolicy',
            },
          },
        },
      });

      expect(fs.existsSync(marker)).toBe(false);
      expect(bridge.buildTelemetry().health).toMatchObject({
        provider_unavailable: false,
        provider_unavailable_reason: null,
      });
      expect(bridge.markAgentAvailability).toHaveBeenCalledWith(true, '');
    } finally {
      delete process.env['SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER'];
    }
  });

  it('retries transient heartbeat transport failures through the bounded observation path', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-structured-transient-'));
    temporaryDirectories.push(cwd);
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    bridge.activeThreadId = 'thread-1';
    bridge.activeThreadStartedAt = Date.now();
    bridge.activeTurnContent = '[HEARTBEAT] test';
    bridge.activeTurnIsHeartbeat = true;
    bridge.processQueue = vi.fn();
    bridge.emitTelemetry = vi.fn();
    bridge.broadcastToThread = vi.fn();
    bridge.scheduleHeartbeatObservationRetry = vi.fn();
    bridge.ensureCodexActiveTurnLimitRetry = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    bridge.handleServerNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed',
          error: {
            message: 'upstream disconnected',
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 503 },
            },
          },
        },
      },
    });

    expect(bridge.ensureCodexActiveTurnLimitRetry).not.toHaveBeenCalled();
    expect(bridge.scheduleHeartbeatObservationRetry).toHaveBeenCalledOnce();
    expect(bridge.heartbeatObservationRetryCount).toBe(1);
    expect(bridge.activeThreadId).toBeNull();
    expect(bridge.processQueue).toHaveBeenCalledOnce();
  });

  it('retains the single bounded account-rotation path for explicit usage limits', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-structured-limit-'));
    temporaryDirectories.push(cwd);
    const bridge = new CodexBridge({ model: 'gpt-test', cwd }) as any;
    bridge.activeThreadId = 'thread-1';
    bridge.activeTurnContent = '[HEARTBEAT] test';
    bridge.activeTurnIsHeartbeat = true;
    bridge.ensureCodexActiveTurnLimitRetry = vi.fn();
    bridge.scheduleHeartbeatObservationRetry = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    bridge.handleServerNotification({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed',
          error: {
            message: 'usage cap reached',
            codexErrorInfo: 'usageLimitExceeded',
          },
        },
      },
    });

    expect(bridge.ensureCodexActiveTurnLimitRetry).toHaveBeenCalledOnce();
    expect(bridge.scheduleHeartbeatObservationRetry).not.toHaveBeenCalled();
    expect(bridge.activeThreadId).toBe('thread-1');
  });
});
