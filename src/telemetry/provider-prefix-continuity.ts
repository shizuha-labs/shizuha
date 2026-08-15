import { createHash } from 'node:crypto';
import type { ChatMessage } from '../provider/types.js';
import type { ToolDefinition } from '../tools/types.js';
import { normalizedToolDefinitions, stableJson } from './prefix-fingerprint.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashJson(value: unknown): string {
  return sha256(stableJson(value));
}

export type ProviderPrefixCacheBreakReason =
  | 'compaction'
  | 'emergency-trim'
  | 'tool-schema-changed'
  | 'system-prompt-changed'
  | 'model-changed'
  | 'sanitized-or-reordered-messages'
  | 'unknown';

export interface SystemPromptSectionHash {
  /** First line of the section (truncated) — names the section without leaking its body. */
  label: string;
  hash: string;
}

export interface ProviderPrefixSnapshot {
  model: string;
  contextWindow?: number;
  systemPromptHash: string;
  /** Per-section hashes (builder.ts joins sections with '\n\n---\n\n') so a
   *  system-prompt change names WHICH section diverged, not just that one did. */
  systemPromptSectionHashes?: SystemPromptSectionHash[];
  toolSchemaHash: string;
  /** Hash of provider-static prefix material: system prompt + tool schema. */
  systemToolPrefixHash: string;
  toolNames: string[];
  chatMessageHashes: string[];
  chatMessageCount: number;
  /** Alias persisted for diagnostics: total messages in the canonical provider payload. */
  totalMessageCount: number;
  /** Hash of the full canonical provider message sequence. */
  canonicalMessagePrefixHash: string;
  /** Marker-based hint from the current payload head, used to explain non-append-only breaks. */
  payloadShapeHint?: 'compaction' | 'emergency-trim';
  /** Hash of model + system/tool prefix + canonical message sequence. */
  payloadHash: string;
  createdAt: number;
}

export interface ProviderPrefixContinuity {
  firstObservation: boolean;
  appendOnly: boolean;
  cacheBreaking: boolean;
  /** Stable machine-readable reason strings. append-only/first-observation are non-break diagnostics. */
  reasons: Array<ProviderPrefixCacheBreakReason | 'append-only' | 'first-observation'>;
  primaryReason?: ProviderPrefixCacheBreakReason;
  previousPayloadHash?: string;
  currentPayloadHash: string;
  previousSystemToolPrefixHash?: string;
  currentSystemToolPrefixHash: string;
  previousCanonicalMessagePrefixHash?: string;
  currentCanonicalMessagePrefixHash: string;
  /** Hash of current messages[0..previousMessageCount); equals previousCanonicalMessagePrefixHash when append-only. */
  currentPriorMessagePrefixHash?: string;
  previousMessageCount?: number;
  currentMessageCount: number;
  firstMessageMismatchIndex?: number;
  addedTools: string[];
  removedTools: string[];
  /** Labels of system-prompt sections that changed/appeared/vanished (when both
   *  snapshots carry section hashes and the system prompt hash differs). */
  changedSystemPromptSections?: string[];
}

const SYSTEM_PROMPT_SECTION_SEPARATOR = '\n\n---\n\n';

export function hashSystemPromptSections(systemPrompt: string): SystemPromptSectionHash[] {
  return systemPrompt.split(SYSTEM_PROMPT_SECTION_SEPARATOR).map((section) => {
    const firstLine = section.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '(empty)';
    return { label: firstLine.slice(0, 80), hash: sha256(section) };
  });
}

/** Diff two section-hash lists by position, labeling each divergence. */
export function diffSystemPromptSections(
  previous: SystemPromptSectionHash[] | undefined,
  current: SystemPromptSectionHash[] | undefined,
): string[] | undefined {
  if (!previous?.length || !current?.length) return undefined;
  const changed: string[] = [];
  const overlap = Math.min(previous.length, current.length);
  for (let i = 0; i < overlap; i++) {
    if (previous[i]!.hash !== current[i]!.hash) {
      const prevLabel = previous[i]!.label;
      const curLabel = current[i]!.label;
      changed.push(prevLabel === curLabel ? curLabel : `${prevLabel} -> ${curLabel}`);
    }
  }
  for (let i = overlap; i < previous.length; i++) changed.push(`removed: ${previous[i]!.label}`);
  for (let i = overlap; i < current.length; i++) changed.push(`added: ${current[i]!.label}`);
  return changed;
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return stableJson(message.content);
}

function payloadLooksCompacted(messages: ChatMessage[]): boolean {
  return messages.some((message, index) => {
    if (index > 2) return false;
    return /\[Conversation Summary\]|compacted conversation|context compacted/i.test(messageText(message));
  });
}

function payloadLooksEmergencyTrimmed(messages: ChatMessage[]): boolean {
  return messages.some((message, index) => {
    if (index > 2) return false;
    return /Heartbeat context hygiene reset dropped|Context budget reset dropped|Emergency tail-truncation|dropping oldest messages|older persisted message\(s\)/i.test(messageText(message));
  });
}

function addReason(reasons: Set<ProviderPrefixCacheBreakReason>, reason: ProviderPrefixCacheBreakReason): void {
  reasons.add(reason);
}

export function buildProviderPrefixSnapshot(args: {
  model: string;
  contextWindow?: number;
  systemPrompt: string;
  tools: ToolDefinition[];
  chatMessages: ChatMessage[];
  createdAt?: number;
}): ProviderPrefixSnapshot {
  const tools = normalizedToolDefinitions(args.tools);
  const toolNames = tools.map((tool) => tool.name);
  const systemPromptHash = sha256(args.systemPrompt);
  const systemPromptSectionHashes = hashSystemPromptSections(args.systemPrompt);
  const toolSchemaHash = hashJson(tools);
  const systemToolPrefixHash = hashJson({ systemPromptHash, toolSchemaHash });
  const chatMessageHashes = args.chatMessages.map((message) => hashJson(message));
  const canonicalMessagePrefixHash = hashJson(chatMessageHashes);
  return {
    model: args.model,
    ...(args.contextWindow != null ? { contextWindow: args.contextWindow } : {}),
    systemPromptHash,
    systemPromptSectionHashes,
    toolSchemaHash,
    systemToolPrefixHash,
    toolNames,
    chatMessageHashes,
    chatMessageCount: chatMessageHashes.length,
    totalMessageCount: chatMessageHashes.length,
    canonicalMessagePrefixHash,
    ...(payloadLooksCompacted(args.chatMessages) ? { payloadShapeHint: 'compaction' as const }
      : payloadLooksEmergencyTrimmed(args.chatMessages) ? { payloadShapeHint: 'emergency-trim' as const }
        : {}),
    payloadHash: hashJson({
      model: args.model,
      systemToolPrefixHash,
      canonicalMessagePrefixHash,
    }),
    createdAt: args.createdAt ?? Date.now(),
  };
}

export function compareProviderPrefixSnapshots(
  previous: ProviderPrefixSnapshot | null | undefined,
  current: ProviderPrefixSnapshot,
): ProviderPrefixContinuity {
  if (!previous) {
    return {
      firstObservation: true,
      appendOnly: true,
      cacheBreaking: false,
      reasons: ['first-observation'],
      currentPayloadHash: current.payloadHash,
      currentSystemToolPrefixHash: current.systemToolPrefixHash,
      currentCanonicalMessagePrefixHash: current.canonicalMessagePrefixHash,
      currentMessageCount: current.chatMessageCount,
      addedTools: [],
      removedTools: [],
    };
  }

  const breakReasons = new Set<ProviderPrefixCacheBreakReason>();
  if (previous.model !== current.model) addReason(breakReasons, 'model-changed');
  let changedSystemPromptSections: string[] | undefined;
  if (previous.systemPromptHash !== current.systemPromptHash) {
    addReason(breakReasons, 'system-prompt-changed');
    changedSystemPromptSections = diffSystemPromptSections(
      previous.systemPromptSectionHashes, current.systemPromptSectionHashes);
  }
  if (previous.toolSchemaHash !== current.toolSchemaHash) addReason(breakReasons, 'tool-schema-changed');

  const addedTools = current.toolNames.filter((name) => !previous.toolNames.includes(name));
  const removedTools = previous.toolNames.filter((name) => !current.toolNames.includes(name));
  if (addedTools.length || removedTools.length) addReason(breakReasons, 'tool-schema-changed');

  const currentPriorMessagePrefixHash = current.chatMessageHashes.length >= previous.chatMessageHashes.length
    ? hashJson(current.chatMessageHashes.slice(0, previous.chatMessageHashes.length))
    : undefined;
  const messagesAreAppendOnly = current.chatMessageHashes.length >= previous.chatMessageHashes.length
    && currentPriorMessagePrefixHash === previous.canonicalMessagePrefixHash;

  let firstMessageMismatchIndex: number | undefined;
  const overlap = Math.min(previous.chatMessageHashes.length, current.chatMessageHashes.length);
  for (let i = 0; i < overlap; i++) {
    if (current.chatMessageHashes[i] !== previous.chatMessageHashes[i]) {
      firstMessageMismatchIndex = i;
      break;
    }
  }
  if (firstMessageMismatchIndex == null && current.chatMessageHashes.length < previous.chatMessageHashes.length) {
    firstMessageMismatchIndex = current.chatMessageHashes.length;
  }

  if (!messagesAreAppendOnly) {
    if (current.payloadShapeHint === 'compaction') {
      addReason(breakReasons, 'compaction');
    } else if (current.payloadShapeHint === 'emergency-trim' || current.chatMessageCount < previous.chatMessageCount) {
      addReason(breakReasons, 'emergency-trim');
    } else {
      addReason(breakReasons, 'sanitized-or-reordered-messages');
    }
  }

  const reasons = [...breakReasons];
  const appendOnly = reasons.length === 0;
  return {
    firstObservation: false,
    appendOnly,
    cacheBreaking: !appendOnly,
    reasons: appendOnly ? ['append-only'] : reasons.length ? reasons : ['unknown'],
    ...(appendOnly ? {} : { primaryReason: (reasons[0] ?? 'unknown') as ProviderPrefixCacheBreakReason }),
    previousPayloadHash: previous.payloadHash,
    currentPayloadHash: current.payloadHash,
    previousSystemToolPrefixHash: previous.systemToolPrefixHash,
    currentSystemToolPrefixHash: current.systemToolPrefixHash,
    previousCanonicalMessagePrefixHash: previous.canonicalMessagePrefixHash,
    currentCanonicalMessagePrefixHash: current.canonicalMessagePrefixHash,
    ...(currentPriorMessagePrefixHash ? { currentPriorMessagePrefixHash } : {}),
    previousMessageCount: previous.chatMessageCount,
    currentMessageCount: current.chatMessageCount,
    ...(firstMessageMismatchIndex != null ? { firstMessageMismatchIndex } : {}),
    addedTools,
    removedTools,
    ...(changedSystemPromptSections?.length ? { changedSystemPromptSections } : {}),
  };
}

export function providerPrefixContinuityLogFields(continuity: ProviderPrefixContinuity): Record<string, unknown> {
  return {
    append_only: continuity.appendOnly,
    cache_breaking: continuity.cacheBreaking,
    cache_break_reason: continuity.primaryReason,
    reasons: continuity.reasons,
    previous_payload_hash: continuity.previousPayloadHash,
    current_payload_hash: continuity.currentPayloadHash,
    previous_system_tool_prefix_hash: continuity.previousSystemToolPrefixHash,
    current_system_tool_prefix_hash: continuity.currentSystemToolPrefixHash,
    previous_prefix_hash: continuity.previousCanonicalMessagePrefixHash,
    stable_prior_prefix_hash: continuity.currentPriorMessagePrefixHash,
    current_prefix_hash: continuity.currentCanonicalMessagePrefixHash,
    previous_message_count: continuity.previousMessageCount,
    current_message_count: continuity.currentMessageCount,
    first_message_mismatch_index: continuity.firstMessageMismatchIndex,
    added_tools: continuity.addedTools,
    removed_tools: continuity.removedTools,
    changed_system_prompt_sections: continuity.changedSystemPromptSections,
  };
}

export function providerPrefixContinuityLogMessage(continuity: ProviderPrefixContinuity): string {
  if (continuity.cacheBreaking) {
    return `SCLI provider payload cache break append_only=false reason=${continuity.primaryReason ?? 'unknown'}`;
  }
  if (continuity.firstObservation) {
    return 'SCLI provider payload prefix initialized append_only=true';
  }
  return `SCLI provider payload append-only check append_only=true stable_prior_prefix_hash=${continuity.currentPriorMessagePrefixHash ?? 'unavailable'}`;
}
