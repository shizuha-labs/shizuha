import { afterEach, describe, expect, it } from 'vitest';
import {
  FLEET_CONTROL_SECRET_ENV,
  fleetControlSecretMatches,
  getFleetControlSecret,
  isHiveOnlyFleetEndpoint,
} from '../../src/daemon/fleet-control-auth.js';

describe('isHiveOnlyFleetEndpoint', () => {
  it('locks lifecycle + config mutations', () => {
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/toggle')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/provision')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/ryo/restart')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/ryo/restart-if-running')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/ryo/reset-session')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/ryo/pause')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/ryo/resume')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/ryo/kill-task')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('PATCH', '/v1/agents/ryo')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('DELETE', '/v1/agents/ryo')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents')).toBe(true);
  });

  it('locks hive inspect endpoints', () => {
    expect(isHiveOnlyFleetEndpoint('GET', '/v1/agents/activity-rates')).toBe(true);
    expect(isHiveOnlyFleetEndpoint('GET', '/v1/agents/ryo/activity')).toBe(true);
  });

  it('leaves agent runtime paths open to normal auth', () => {
    expect(isHiveOnlyFleetEndpoint('GET', '/v1/agents')).toBe(false);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/ryo/message')).toBe(false);
    expect(isHiveOnlyFleetEndpoint('POST', '/v1/agents/claude-token-pressure')).toBe(false);
    expect(isHiveOnlyFleetEndpoint('GET', '/v1/agents/ryo/credentials')).toBe(false);
  });
});

describe('fleetControlSecretMatches', () => {
  afterEach(() => {
    delete process.env[FLEET_CONTROL_SECRET_ENV];
  });

  it('matches exact secret when configured', () => {
    process.env[FLEET_CONTROL_SECRET_ENV] = 'hive-only-secret-xyz';
    expect(getFleetControlSecret()).toBe('hive-only-secret-xyz');
    expect(fleetControlSecretMatches('hive-only-secret-xyz')).toBe(true);
    expect(fleetControlSecretMatches('wrong')).toBe(false);
    expect(fleetControlSecretMatches('')).toBe(false);
    expect(fleetControlSecretMatches(undefined)).toBe(false);
  });

  it('fails closed when secret unset', () => {
    delete process.env[FLEET_CONTROL_SECRET_ENV];
    expect(fleetControlSecretMatches('anything')).toBe(false);
  });
});
