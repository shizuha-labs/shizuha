// @vitest-environment jsdom
/**
 * Tests for the CoreHealth component (SCLI-322).
 *
 * These tests verify the health handshake UI renders correctly in various
 * states: loading, connected, unreachable, and upgrade-required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CoreHealthView from '../../src/web/components/CoreHealth';

// Mock the Tauri invoke API
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock fetch for browser dev fallback
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock AbortSignal.timeout
if (!AbortSignal.timeout) {
  (AbortSignal as any).timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CoreHealthView', () => {
  it('shows loading state initially', () => {
    // Don't resolve the fetch so it stays loading
    mockFetch.mockImplementation(() => new Promise(() => {}));
    render(<CoreHealthView />);
    // Should show the loading skeleton
    expect(screen.getByText('Shizuha Desktop')).toBeDefined();
  });

  it('shows connected state with health data', async () => {
    const mockHealth = {
      version: '0.1.0',
      protocolVersion: 1,
      authStatus: {
        authenticated: true,
        account: 'user@shizuha.com',
        message: 'Authenticated',
      },
      providers: ['cortex', 'anthropic'],
      models: ['claude-sonnet-4', 'gpt-4o'],
      capabilities: ['sessions', 'streaming'],
      message: 'OK',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealth,
    });

    render(<CoreHealthView />);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeDefined();
    });

    expect(screen.getByText('0.1.0')).toBeDefined();
    expect(screen.getByText('v1')).toBeDefined();
    expect(screen.getByText('Authenticated')).toBeDefined();
    expect(screen.getByText('user@shizuha.com')).toBeDefined();
    expect(screen.getByText('cortex, anthropic')).toBeDefined();
  });

  it('shows unauthenticated state', async () => {
    const mockHealth = {
      version: '0.1.0',
      protocolVersion: 1,
      authStatus: {
        authenticated: false,
        account: '',
        message: 'Not authenticated',
      },
      providers: [],
      models: [],
      capabilities: [],
      message: '',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealth,
    });

    render(<CoreHealthView />);

    await waitFor(() => {
      expect(screen.getByText('Not Authenticated')).toBeDefined();
    });
  });

  it('shows error state when core is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));

    render(<CoreHealthView />);

    await waitFor(() => {
      expect(screen.getByText('Core Unreachable')).toBeDefined();
    });

    expect(
      screen.getByText(/Start the Shizuha core first/)
    ).toBeDefined();
  });

  it('shows upgrade required for protocol mismatch', async () => {
    const mockHealth = {
      version: '0.2.0',
      protocolVersion: 2,
      authStatus: {
        authenticated: true,
        account: '',
        message: '',
      },
      providers: [],
      models: [],
      capabilities: [],
      message: '',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealth,
    });

    render(<CoreHealthView />);

    await waitFor(() => {
      expect(screen.getByText('Upgrade Required')).toBeDefined();
    });
  });

  it('retries connection on button click', async () => {
    // First call fails
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));
    // Second call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        version: '0.1.0',
        protocolVersion: 1,
        authStatus: { authenticated: true, account: '', message: '' },
        providers: ['cortex'],
        models: [],
        capabilities: [],
        message: '',
      }),
    });

    render(<CoreHealthView />);

    await waitFor(() => {
      expect(screen.getByText('Core Unreachable')).toBeDefined();
    });

    // Click retry
    const retryButton = screen.getByText('Retry Connection');
    await userEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeDefined();
    });

    // Should have called fetch twice
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('shows HTTP error status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
    });

    render(<CoreHealthView />);

    await waitFor(() => {
      // HTTP error with reachable=true and serverError=true → shows Core Error
      expect(screen.getByText('Core Error')).toBeDefined();
    });

    expect(screen.getByText(/Core returned HTTP 503/)).toBeDefined();
  });
});
