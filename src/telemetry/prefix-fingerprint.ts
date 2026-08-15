import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../tools/types.js';

export interface PrefixFingerprintInput {
  systemPrompt: string;
  tools: ToolDefinition[];
  model?: string;
  profile?: string;
  mode?: string;
}

export interface PrefixFingerprint {
  hash: string;
  systemPromptHash: string;
  toolSchemaHash: string;
  toolNames: string[];
  systemPromptChars: number;
  toolCount: number;
  model?: string;
  profile?: string;
  mode?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

export function normalizedToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

export function computePrefixFingerprint(input: PrefixFingerprintInput): PrefixFingerprint {
  const tools = normalizedToolDefinitions(input.tools);
  const toolSchemaJson = stableJson(tools);
  const systemPromptHash = sha256(input.systemPrompt);
  const toolSchemaHash = sha256(toolSchemaJson);
  return {
    hash: sha256(stableJson({ systemPromptHash, toolSchemaHash, model: input.model ?? '', profile: input.profile ?? '', mode: input.mode ?? '' })),
    systemPromptHash,
    toolSchemaHash,
    toolNames: tools.map((t) => t.name),
    systemPromptChars: input.systemPrompt.length,
    toolCount: tools.length,
    ...(input.model ? { model: input.model } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
  };
}

export function comparePrefixFingerprints(previous: PrefixFingerprint | null | undefined, current: PrefixFingerprint): Record<string, unknown> {
  if (!previous) return { changed: false, reason: 'first-observation' };
  const addedTools = current.toolNames.filter((n) => !previous.toolNames.includes(n));
  const removedTools = previous.toolNames.filter((n) => !current.toolNames.includes(n));
  return {
    changed: previous.hash !== current.hash,
    hashChanged: previous.hash !== current.hash,
    systemPromptChanged: previous.systemPromptHash !== current.systemPromptHash,
    toolSchemaChanged: previous.toolSchemaHash !== current.toolSchemaHash,
    toolOrderOrSetChanged: previous.toolNames.join('\0') !== current.toolNames.join('\0'),
    addedTools,
    removedTools,
    previousHash: previous.hash,
    currentHash: current.hash,
  };
}

export class PrefixFingerprintTracker {
  private previous = new Map<string, PrefixFingerprint>();

  observe(key: string, current: PrefixFingerprint): Record<string, unknown> & { current: PrefixFingerprint } {
    const comparison = comparePrefixFingerprints(this.previous.get(key), current);
    this.previous.set(key, current);
    return { ...comparison, current };
  }
}
