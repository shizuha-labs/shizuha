import { describe, expect, it } from 'vitest';
import {
  isConnectClientId,
  shouldEscalateEmptyTurnAsProviderFailure,
} from '../../src/shared/connect-inject.js';

describe('connect inject-once policy', () => {
  it('detects connect client ids', () => {
    expect(isConnectClientId('connect:abc')).toBe(true);
    expect(isConnectClientId('dashboard')).toBe(false);
    expect(isConnectClientId(null)).toBe(false);
  });

  it('never escalates Connect inject silence as provider failure', () => {
    expect(shouldEscalateEmptyTurnAsProviderFailure({
      isConnectInject: true,
      modelProducedEvents: false,
      isSilentSystemUpdate: false,
    })).toBe(false);
  });

  it('never escalates model-only turns (reasoning / empty final) as provider failure', () => {
    expect(shouldEscalateEmptyTurnAsProviderFailure({
      isConnectInject: false,
      modelProducedEvents: true,
      isSilentSystemUpdate: false,
    })).toBe(false);
  });

  it('never escalates silent system task-update turns', () => {
    expect(shouldEscalateEmptyTurnAsProviderFailure({
      isConnectInject: false,
      modelProducedEvents: false,
      isSilentSystemUpdate: true,
    })).toBe(false);
  });

  it('escalates only pure no-model-event empty turns (non-Connect)', () => {
    expect(shouldEscalateEmptyTurnAsProviderFailure({
      isConnectInject: false,
      modelProducedEvents: false,
      isSilentSystemUpdate: false,
    })).toBe(true);
  });
});
