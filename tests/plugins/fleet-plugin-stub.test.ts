import { describe, expect, it } from 'vitest';
import { isK8sAgent, shouldSpawnK8sAgent } from '../../src/plugins/fleet/k8s-backend.stub.js';

describe('fleet plugin stub', () => {
  it('never treats an agent as a k8s fleet pod', () => {
    expect(isK8sAgent({ username: 'kai', id: 'x' } as never)).toBe(false);
    expect(shouldSpawnK8sAgent({ username: 'kai', id: 'x' } as never)).toBe(false);
  });
});
