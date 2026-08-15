import { describe, expect, it } from 'vitest';
import { renderAgentManifest } from '../../src/daemon/k8s-backend.js';
import type { AgentInfo } from '../../src/daemon/types.js';

describe('SCLI-331 runtime release projection into agent Deployments', () => {
  it('pins the agent/init image by immutable digest and stamps applied generation/digest', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const manifest = renderAgentManifest({
      id: 'jun-id',
      username: 'jun',
      name: 'Jun',
      email: 'jun@shizuha.com',
      role: 'agent',
      status: 'active',
      mcpServers: [],
      personalityTraits: {},
      skills: [],
    } as AgentInfo, {
      command: 'gateway',
      model: 'cortex/DeepSeek-V4-Flash',
      contextPrompt: 'test',
      password: 'test-password',
    }, undefined, {
      imageOverride: `localhost:30500/shizuha-agent-runtime@${digest}`,
      runtimeRelease: {
        generation: 7,
        image_digest: digest,
        display_tag: 'localhost:30500/shizuha-agent-runtime:harness-reviewed',
        source_commit: 'b'.repeat(40),
        intent: 'promote',
        rollback_of_generation: null,
        approved_at: '2026-07-12T22:00:00Z',
      },
    });
    expect(manifest.match(new RegExp(`image: localhost:30500/shizuha-agent-runtime@${digest}`, 'g'))?.length).toBe(2);
    expect(manifest).toContain('shizuha.io/runtime-release-generation: "7"');
    expect(manifest).toContain(`shizuha.io/runtime-release-digest: "${digest}"`);
  });
});
