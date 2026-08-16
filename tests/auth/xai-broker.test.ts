import { describe, expect, it } from 'vitest';

import {
  HIVE_XAI_GROK_MODEL,
  hiveDirectXaiUpstreamModel,
  isHiveDirectXaiGrokModel,
  parseBrokerXaiPayload,
} from '../../src/auth/xai-broker.js';

describe('Hive xAI access-only lease', () => {
  it('recognizes the explicit Hive xAI Grok Build model and rejects Cortex offers', () => {
    expect(isHiveDirectXaiGrokModel(HIVE_XAI_GROK_MODEL)).toBe(true);
    expect(isHiveDirectXaiGrokModel('xai:grok-4.6')).toBe(true);
    expect(isHiveDirectXaiGrokModel('xai:grok-4.5')).toBe(true);
    expect(isHiveDirectXaiGrokModel('cortex/grok-4.5')).toBe(false);
    expect(isHiveDirectXaiGrokModel('cortex/grok-4.6')).toBe(false);
    expect(isHiveDirectXaiGrokModel('xai/grok-4.5')).toBe(false);
    expect(isHiveDirectXaiGrokModel('grok-4.5')).toBe(false);
    expect(hiveDirectXaiUpstreamModel('xai:grok-4.6')).toBe('grok-4.6');
    expect(hiveDirectXaiUpstreamModel('xai:grok-4.5')).toBe('grok-4.5');
    expect(hiveDirectXaiUpstreamModel('grok-4.6')).toBe('grok-4.6');
  });

  it('accepts coordinator access-only payloads and refuses a refresh token copy', () => {
    const ok = parseBrokerXaiPayload(JSON.stringify({
      auth_mode: 'xaiAccessToken',
      access_token: 'xai-access-1',
      email: 'ops@shizuha.com',
      account_id: 'acct-1',
    }));
    expect(ok).toEqual({
      accessToken: 'xai-access-1',
      email: 'ops@shizuha.com',
      accountId: 'acct-1',
    });

    expect(parseBrokerXaiPayload(JSON.stringify({
      access_token: 'xai-access-1',
      refresh_token: 'rt-must-not-leave-hive',
    }))).toBeNull();
    expect(parseBrokerXaiPayload('not-json')).toBeNull();
    expect(parseBrokerXaiPayload(JSON.stringify({ email: 'ops@shizuha.com' }))).toBeNull();
  });
});
