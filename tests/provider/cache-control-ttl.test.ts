import { describe, expect, it } from 'vitest';
import { resolveCortexCacheControl } from '../../src/provider/vllm.js';

describe('resolveCortexCacheControl', () => {
  it('defaults generic SCLI to 5m ephemeral', () => {
    expect(resolveCortexCacheControl(undefined, {})).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('uses 30m for hive/fleet agents', () => {
    expect(resolveCortexCacheControl('interactive', { SHIZUHA_AGENT_ID: 'agent-nagi' })).toEqual({
      type: 'ephemeral',
      ttl: '30m',
    });
  });

  it('treats live fleet AGENT_USERNAME as hive even without SHIZUHA_AGENT_*', () => {
    expect(resolveCortexCacheControl('interactive', { AGENT_USERNAME: 'saki' })).toEqual({
      type: 'ephemeral',
      ttl: '30m',
    });
  });

  it('Hive agents never send bare ephemeral, even for benchmark cells', () => {
    expect(resolveCortexCacheControl('benchmark', { SHIZUHA_AGENT_ID: 'agent-nagi' })).toEqual({
      type: 'ephemeral',
      ttl: '30m',
    });
  });

  it('Hive ignores SHIZUHA_CACHE_CONTROL=ephemeral (operator 2026-08-22)', () => {
    expect(resolveCortexCacheControl('interactive', {
      SHIZUHA_AGENT_ID: 'agent-nagi',
      SHIZUHA_CACHE_CONTROL: 'ephemeral',
    })).toEqual({
      type: 'ephemeral',
      ttl: '30m',
    });
  });

  it('honors SHIZUHA_CACHE_CONTROL=ephemeral override for non-Hive', () => {
    expect(resolveCortexCacheControl('interactive', { SHIZUHA_CACHE_CONTROL: 'ephemeral' })).toEqual({
      type: 'ephemeral',
    });
  });
});
