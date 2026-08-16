import { describe, expect, it } from 'vitest';
import { isK8sAgent, shouldSpawnK8sAgent } from '../../src/daemon/k8s-backend.js';

describe('local k8s adapter', () => {
  it('never treats an agent as a k8s fleet pod', () => {
    expect(isK8sAgent({ username: 'kai', id: 'x' } as never)).toBe(false);
    expect(shouldSpawnK8sAgent({ username: 'kai', id: 'x' } as never)).toBe(false);
  });
});
