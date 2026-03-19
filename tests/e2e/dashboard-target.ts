import { test } from '@playwright/test';

const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'shizuha-nginx', 'host.docker.internal']);

export function getDashboardUrl(defaultUrl = 'http://localhost:8015'): string {
  return process.env.DASHBOARD_URL || defaultUrl;
}

export function guardRemoteDashboardTarget(url: string): void {
  const hostname = new URL(url).hostname;
  const allowRemote = process.env.ALLOW_REMOTE_DASHBOARD_E2E === '1';
  test.skip(
    !SAFE_HOSTS.has(hostname) && !allowRemote,
    `Refusing to run dashboard E2E against remote target ${url}. Set ALLOW_REMOTE_DASHBOARD_E2E=1 to opt in.`,
  );
}
