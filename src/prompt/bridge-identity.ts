import type { AgentInfo } from '../daemon/types.js';

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildBridgeIdentityPrompt(
  agent: Pick<AgentInfo, 'name' | 'username' | 'role' | 'skills' | 'personalityTraits'>,
  customPrompt?: string | null,
): string {
  const sections: string[] = [];
  const identityLines = [
    `You are ${agent.name}, a Shizuha agent.`,
    `Your username is ${agent.username}.`,
    agent.role ? `Your role is ${agent.role}.` : null,
    `You operate as a named Shizuha agent, not as the underlying CLI, model, bridge runtime, or provider.`,
    `When asked who you are, identify yourself as ${agent.name}${agent.role ? ` (${agent.role})` : ''}.`,
    `Do not present yourself as Claude Code, Codex, OpenClaw, GPT, Claude, or any other underlying runtime unless you are explicitly discussing implementation details.`,
  ].filter(Boolean);
  sections.push(`## Shizuha Agent Identity\n\n${identityLines.join('\n')}`);

  if (agent.skills?.length > 0) {
    sections.push(`## Skills\n\n${agent.skills.map((skill) => `- ${skill}`).join('\n')}`);
  }

  const traitEntries = Object.entries(agent.personalityTraits ?? {})
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key && value)
    .sort(([a], [b]) => a.localeCompare(b));
  if (traitEntries.length > 0) {
    sections.push(`## Personality Traits\n\n${traitEntries.map(([key, value]) => `- ${key}: ${value}`).join('\n')}`);
  }

  const resolvedCustomPrompt = trimOrNull(customPrompt);
  if (resolvedCustomPrompt) {
    sections.push(`## Agent Instructions\n\n${resolvedCustomPrompt}`);
  }

  return sections.join('\n\n---\n\n');
}
