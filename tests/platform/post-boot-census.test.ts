import { describe, expect, it } from 'vitest';
import {
  censusRepoVisibility,
  formatCensusAlarm,
  runPostBootAccessCensus,
} from '../../src/platform/post-boot-census.js';

describe('post-boot access census', () => {
  it('names a missing expected repo', () => {
    const probes = censusRepoVisibility(
      ['shizuha-labs/pulse', 'shizuha-labs/hive'],
      new Set(['shizuha-labs/pulse']),
    );
    expect(formatCensusAlarm(probes)).toBe('post-boot access drift: repo:shizuha-labs/hive');
  });

  it('alarms on a confirmed origin 404 and not on transport failure', async () => {
    const alarm = await runPostBootAccessCensus({
      SHIZUHA_EXPECTED_REPOS: 'shizuha-labs/hive,shizuha-labs/pulse',
      SHIZUHA_ORIGIN_API: 'https://origin.example',
      FORGEJO_TOKEN: 'token',
    }, (async (url: string) => {
      if (String(url).endsWith('/shizuha-labs/hive')) return { status: 404 };
      throw new Error('timeout');
    }) as unknown as typeof fetch);
    expect(alarm).toBe('post-boot access drift: repo:shizuha-labs/hive');
  });

  it('stays quiet when the expected set is visible', async () => {
    const alarm = await runPostBootAccessCensus({
      SHIZUHA_EXPECTED_REPOS: 'shizuha-labs/pulse',
      SHIZUHA_VISIBLE_REPOS: 'shizuha-labs/pulse',
      SHIZUHA_EXPECTED_TOOLS: 'pulse_get_task',
      SHIZUHA_LIVE_TOOLS: 'pulse_get_task',
      SHIZUHA_LIST_AGENTS_OK: '1',
      CI_LOGS_BEARER: 'present',
      CONNECT_URL: 'http://connect',
    });
    expect(alarm).toBeNull();
  });
});
