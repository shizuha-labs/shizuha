import * as fs from 'node:fs';
import type { Message, ContentBlock, ToolResultContent } from '../agent/types.js';
import type { LLMProvider, ChatMessage } from '../provider/types.js';
import { countTokens } from '../utils/tokens.js';
import { estimateTokens, getSafetyFactor, compactionThresholdFor } from '../prompt/context.js';
import { logger } from '../utils/logger.js';

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const v = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
import { isCortexModelId } from '../provider/registry.js';

// Compaction prompt modeled after Claude Code's 9-section format (node-forge.js:15447-15550)
const COMPACTION_PROMPT = `You are a conversation compactor for a coding agent. Analyze the provided oldest conversation prefix and produce a detailed semantic summary.

First, analyze the conversation in <analysis> tags (this will be discarded). Then produce the summary in <summary> tags.

The summary MUST include ALL of these sections:

1. **Primary Request and Intent**: The original task and what the user wants accomplished.
2. **Key Technical Concepts**: Technologies, frameworks, algorithms, and patterns involved.
3. **Files and Code Sections**: Every file created/modified/read with FULL paths. Include key code snippets (functions, classes, important logic) verbatim — not just descriptions.
4. **Errors and Fixes**: Every error encountered, exact error messages, root causes, and how they were resolved (or if still open). Include failing test names and tracebacks.
5. **Problem Solving**: Approaches tried, what worked, what didn't, and why.
6. **All User Messages**: Every non-tool-result user message, preserving their exact intent.
7. **Pending Tasks**: What has been completed and what remains to be done.
8. **Current Work**: The most recent state — what was the agent doing on the last few turns?
9. **Optional Next Step**: What should the agent do next?

CRITICAL: This summary replaces the provided oldest prefix. A recent suffix will be appended verbatim after it. If you omit test failures, file paths, error messages, or code state from this prefix, the agent may repeat work or miss bugs. A longer, complete summary is far better than a short, lossy one.`;

function fallbackMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content as ContentBlock[]).map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool_use') return `[tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 500)}]`;
    if (block.type === 'tool_result') {
      const tr = block as ToolResultContent;
      return `[tool_result ${tr.toolUseId}${tr.isError ? ' error' : ''}] ${tr.content}`;
    }
    if (block.type === 'reasoning') return '[thinking]';
    return JSON.stringify(block);
  }).join('\n');
}

/**
 * Heading under which the ORIGINAL user task is carried verbatim through every
 * compaction. Kept stable: later compactions find and re-emit this exact block
 * instead of re-deriving intent from a summary of a summary.
 */
export const TASK_ANCHOR_HEADING = '## Original task (verbatim — preserved across every compaction)';

/**
 * Heading for the CURRENT instruction, refreshed at each compaction.
 *
 * The original task alone is not enough: a long-lived session spans many
 * different requests (shizuha1 ran two days), so pinning only the first message
 * would anchor on stale intent — a different way to be confidently wrong. The
 * tail kept by compaction is only ~4 messages and is often pure tool traffic,
 * so without this the live instruction can fall out of context entirely.
 */
export const CURRENT_TASK_HEADING = '## Current instruction (refreshed at each compaction)';

/** Read a previously-emitted anchor section back out of a summary message. */
function sectionFromPriorSummary(messages: Message[], heading: string): string {
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : '';
    const at = text.indexOf(heading);
    if (at === -1) continue;
    const after = text.slice(at + heading.length);
    const end = after.search(/\n#{1,3} /);
    const body = (end === -1 ? after : after.slice(0, end)).trim();
    if (body) return body;
  }
  return '';
}

/** The newest genuine user request in this window, if any. */
function latestUserInstruction(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (Array.isArray(m.content)
      && (m.content as ContentBlock[]).some((b) => b.type === 'tool_result')) continue;
    const text = fallbackMessageText(m).trim();
    if (!text || text.startsWith('[Conversation Summary]')) continue;
    return text;
  }
  return '';
}

/**
 * Current instruction: the newest real user request, else whatever the previous
 * compaction recorded. Never blanks out just because the recent tail happened
 * to be all tool calls.
 */
export function extractCurrentTask(messages: Message[]): string {
  return latestUserInstruction(messages)
    || sectionFromPriorSummary(messages, CURRENT_TASK_HEADING);
}

/**
 * The original task, resolved once and then carried forever.
 *
 * Compaction is fed the CURRENT message list, which after a previous compaction
 * is `[Conversation Summary] + short tail`. Summarizing that produces a summary
 * of a summary, and the original intent erodes a little more each round. On
 * 2026-08-04 a session compacted twice in ten minutes and the surviving
 * "summary" had mutated an obstacle the agent worked around (Pulse's
 * BLOCKER_FOCUS_REQUIRED guard, hit while deferring PLAT-5707) into its
 * supposed mission — it then hunted for non-existent "focus guard" bugs and ran
 * a 3039-test suite looking for failures that were never there.
 *
 * So: if an anchor already exists, re-emit it byte-for-byte. Only derive a new
 * one from a real user message when there is no anchor yet.
 */
export function extractTaskAnchor(messages: Message[]): string {
  // An anchor already exists → re-emit it byte-for-byte. Re-deriving would read
  // the summary envelope and let the original intent drift.
  const existing = sectionFromPriorSummary(messages, TASK_ANCHOR_HEADING);
  if (existing) return existing;
  // No anchor yet — derive from the first genuine user turn. Skip tool results
  // and any prior summary envelope so we anchor on intent, not on machinery.
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (Array.isArray(m.content)
      && (m.content as ContentBlock[]).some((b) => b.type === 'tool_result')) continue;
    const text = fallbackMessageText(m).trim();
    if (!text || text.startsWith('[Conversation Summary]')) continue;
    return text;
  }
  return '';
}

/**
 * Reject a "summary" that is not one.
 *
 * The only quality gate used to be `countTokens(summary) < MIN_SUMMARY_TOKENS`,
 * i.e. pure length. The 2026-08-04 amnesia summary was ~260 tokens — over the
 * floor — and consisted of the model's own musing plus a raw serialized
 * `tool_use` block it had echoed from its input. It sailed through, and the
 * the old deterministic fallback would have hidden the quality failure.
 * Length is not a proxy for content.
 */
export function isDegenerateSummary(summary: string): { degenerate: boolean; reason: string } {
  const text = (summary ?? '').trim();
  if (!text) return { degenerate: true, reason: 'empty' };

  // 1. Echoed transcript machinery: serialized content blocks copied verbatim
  //    out of the conversation text we fed in.
  const serialized = text.match(
    /"type"\s*:\s*"(tool_use|tool_result|text)"|"tool_use_id"|"toolUseId"|\[\{"type"|[｜|]DSML[｜|]/g,
  );
  if (serialized && serialized.length >= 2) {
    return { degenerate: true, reason: 'echoed_serialized_tool_blocks' };
  }
  // A single block still matters if it dominates the output.
  const jsonBlobChars = (text.match(/\[\{"type"[\s\S]{0,4000}?\}\]/g) ?? [])
    .reduce((n, s) => n + s.length, 0);
  if (jsonBlobChars > text.length * 0.25) {
    return { degenerate: true, reason: 'dominated_by_serialized_blocks' };
  }

  // 2. Drift marker: the summary talking ABOUT a previous summary rather than
  //    about the work. This is the fingerprint of summary-of-summary decay.
  if (/\bthe (conversation |previous )?summary (says|said|states|mentions|indicates)\b/i.test(text)
    || /\baccording to the (conversation )?summary\b/i.test(text)) {
    return { degenerate: true, reason: 'summarized_a_summary' };
  }

  // Deliberately NOT checking for "has numbered sections". A valid summary that
  // simply lacks headings is still a summary, and rejecting it would throw away
  // the model's synthesis for a formatting preference.
  // MIN_SUMMARY_TOKENS already rejects the too-short case; the two checks above
  // are the precise fingerprints of the failure actually observed.
  return { degenerate: false, reason: '' };
}

/** Strip echoed transcript machinery (serialized tool/content blocks copied
 *  verbatim from the conversation) out of a summary, keeping the model's own
 *  prose. Models often write a genuine narrative AROUND pasted blocks; the
 *  residue is frequently a perfectly usable summary (shizuha5 2026-08-10). */
export function stripEchoedToolBlocks(text: string): string {
  let out = (text ?? '')
    // whole serialized block arrays, e.g. [{"type":"tool_result",...}]
    .replace(/\[\{"type"[\s\S]{0,20000}?\}\]/g, ' ')
    // fenced code blocks that contain serialized block markers
    .replace(/```[\s\S]{0,20000}?```/g, (m) => (
      /"type"\s*:\s*"(tool_use|tool_result|text)"|"tool_use_id"|"toolUseId"/.test(m) ? ' ' : m
    ));
  out = out
    .split('\n')
    .filter((line) => !/"type"\s*:\s*"(tool_use|tool_result|text)"|"tool_use_id"|"toolUseId"/.test(line))
    .join('\n');
  // DSML wire markup (DeepSeek tool-call special tokens leaked as text —
  // 2026-08-10 DSpark): tags and whole invoke blocks are machinery, not prose.
  out = out
    .replace(/<[｜|]DSML[｜|]invoke\b[^>]*>[\s\S]*?<\/[｜|]DSML[｜|]invoke>/g, ' ')
    .replace(/<\/?[｜|]DSML[｜|][^>]{0,200}>/g, ' ');
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Live progress reported by the streaming summary call, for a TUI progress bar. */
export interface CompactionProgress {
  /** Estimated output tokens generated so far (chars / 4). */
  outputTokens: number;
  /** Raw output chars generated so far. */
  outputChars: number;
  /** Max output budget for this compaction call (the bar's denominator). */
  budget: number;
  /** Which streaming pass is running. */
  stage: 'summary' | 'retry';
}

export interface CompactionOptions {
  force?: boolean;
  customInstructions?: string;
  abortSignal?: AbortSignal;
  overheadTokens?: number;
  planFilePath?: string;
  onProgress?: (p: CompactionProgress) => void;
  sessionId?: string;
  /** Optional stricter final projection target, including overhead tokens. */
  targetFinalTokens?: number;
  /** Explicit /compact may create a useful semantic checkpoint below threshold. */
  allowNonReducing?: boolean;
  /** Internal hierarchical-prefix pass counter. */
  semanticPass?: number;
}

export class CompactionQualityError extends Error {
  readonly code = 'COMPACTION_QUALITY_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'CompactionQualityError';
  }
}

export class CompactionCapacityError extends Error {
  readonly code = 'COMPACTION_CAPACITY_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'CompactionCapacityError';
  }
}

function isToolResultMessage(message: Message | undefined): boolean {
  return Boolean(message
    && Array.isArray(message.content)
    && (message.content as ContentBlock[]).some((block) => block.type === 'tool_result'));
}

/** Serialize one complete message for semantic prefix compaction. */
function serializeMessageForCompaction(message: Message): string {
  if (typeof message.content === 'string') {
    return `[${message.role}]: ${message.content}`;
  }
  const blocks = (message.content as ContentBlock[]).map((block) => {
    if (block.type === 'tool_result') {
      const toolResult = block as ToolResultContent;
      if (toolResult.image) {
        return JSON.stringify({
          type: toolResult.type,
          toolUseId: toolResult.toolUseId,
          content: toolResult.content,
          isError: toolResult.isError,
          image: '[image data omitted]',
        });
      }
    }
    if (block.type === 'reasoning') {
      const reasoning = block as {
        id: string;
        summary?: Array<{ text: string }>;
        encryptedContent?: string;
        rawContent?: string;
      };
      if (reasoning.rawContent) return JSON.stringify({ type: 'reasoning', rawContent: reasoning.rawContent });
      const summaryText = reasoning.summary?.map((item) => item.text).filter(Boolean).join(' ') || '[thinking]';
      return JSON.stringify({ type: 'reasoning', summary: summaryText });
    }
    return JSON.stringify(block);
  });
  return `[${message.role}]: [${blocks.join(',')}]`;
}

interface SemanticPrefix {
  conversationText: string;
  prefixEnd: number;
  conversationTokens: number;
}

/**
 * Select one complete oldest prefix that fits the maintenance request.
 *
 * Nothing is elided from the selected prefix. Everything after prefixEnd is an
 * immutable suffix and is attached byte-for-byte to the semantic summary. If a
 * single oldest message cannot fit, fail closed so the caller can retain the
 * prior projection instead of pretending a partial summary is complete.
 */
function selectSemanticPrefix(
  messages: Message[],
  model: string,
  maxConversationTokens: number,
  maxTokens: number,
): SemanticPrefix {
  if (messages.length === 0) {
    throw new CompactionCapacityError('Cannot compact an empty transcript');
  }

  const recentTailBudget = Math.min(
    parsePositiveIntEnv('SHIZUHA_COMPACTION_RECENT_TAIL_TOKENS', 16_000),
    Math.max(4_000, Math.floor(maxTokens * 0.08)),
  );
  let desiredPrefixEnd = messages.length;
  let recentTokens = 0;
  while (desiredPrefixEnd > 0) {
    const nextTokens = estimateTokens([messages[desiredPrefixEnd - 1]!], model);
    if (recentTokens > 0 && recentTokens + nextTokens > recentTailBudget) break;
    recentTokens += nextTokens;
    desiredPrefixEnd--;
  }

  // Forced/manual compaction of a short transcript must still make progress,
  // but retain at least the newest message verbatim whenever possible.
  if (desiredPrefixEnd === 0) {
    desiredPrefixEnd = messages.length > 1 ? Math.max(1, messages.length - 1) : 1;
  }

  const serialized = messages
    .slice(0, desiredPrefixEnd)
    .map((message) => serializeMessageForCompaction(message));
  const oldestTokens = countTokens(serialized[0]!, model);
  if (oldestTokens > maxConversationTokens) {
    throw new CompactionCapacityError(
      `The oldest message alone exceeds the semantic compaction input budget (${oldestTokens}/${maxConversationTokens} tokens)`,
    );
  }

  // Tokenize O(log n) complete-prefix candidates rather than repeatedly
  // joining/tokenizing every growing prefix (quadratic on large resumes).
  let prefixEnd = 1;
  let conversationTokens = oldestTokens;
  let low = 2;
  let high = serialized.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateTokens = countTokens(serialized.slice(0, mid).join('\n\n'), model);
    if (candidateTokens <= maxConversationTokens) {
      prefixEnd = mid;
      conversationTokens = candidateTokens;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Never leave a tool_result orphan at the front of the preserved suffix.
  // Move its matching assistant/tool_use unit back into the suffix rather than
  // swallowing the result into a different semantic segment.
  while (prefixEnd > 0 && prefixEnd < messages.length && isToolResultMessage(messages[prefixEnd])) {
    prefixEnd--;
  }
  if (prefixEnd === 0) {
    throw new CompactionCapacityError('No complete semantic prefix fits without splitting a tool-use/result pair');
  }

  const conversationText = serialized.slice(0, prefixEnd).join('\n\n');
  conversationTokens = countTokens(conversationText, model);
  return { conversationText, prefixEnd, conversationTokens };
}

/**
 * Build a transactional semantic projection: summary of an oldest prefix plus
 * the byte-identical recent suffix. Any fit failure rejects the whole rewrite.
 */
function projectCompactedMessages(
  messages: Message[],
  summary: string,
  suffixStart: number,
  options?: CompactionOptions,
): Message[] {
  const taskAnchor = extractTaskAnchor(messages);
  const currentTask = extractCurrentTask(messages);
  const anchorBlocks = [
    taskAnchor ? `${TASK_ANCHOR_HEADING}\n${taskAnchor}` : '',
    currentTask && currentTask !== taskAnchor ? `${CURRENT_TASK_HEADING}\n${currentTask}` : '',
  ].filter(Boolean);
  const summaryBody = anchorBlocks.length
    ? `${anchorBlocks.join('\n\n')}\n\n## Summary\n${summary}`
    : summary;
  const compacted: Message[] = [
    {
      role: 'user',
      content: `[Conversation Summary]\n${summaryBody}`,
      timestamp: Date.now(),
    },
    {
      role: 'assistant',
      content: 'I have the full context from the conversation summary. Continuing the task.',
      timestamp: Date.now(),
    },
  ];

  const recent = messages.slice(suffixStart);
  compacted.push(...recent);

  const planAlreadyPresent = compacted.some((message) => (
    typeof message.content === 'string'
    && message.content.startsWith('[System] A plan file exists from plan mode at:')
  ));
  if (options?.planFilePath && !planAlreadyPresent) {
    try {
      const planContent = fs.readFileSync(options.planFilePath, 'utf-8');
      if (planContent.trim()) {
        compacted.push({
          role: 'user',
          content: `[System] A plan file exists from plan mode at: ${options.planFilePath}\n\nPlan contents:\n${planContent}\n\nIf this plan is relevant to the current work, continue working on it.`,
          timestamp: Date.now(),
        });
        compacted.push({
          role: 'assistant',
          content: 'I have the plan file context. Continuing with the plan.',
          timestamp: Date.now(),
        });
        logger.info({ planFilePath: options.planFilePath }, 'Plan file content preserved after compaction');
      }
    } catch {
      // Plan file does not exist or cannot be read.
    }
  }

  return compacted;
}

/**
 * Single-pass context compaction. When context exceeds threshold,
 * summarize the conversation using the LLM and replace the message history.
 */
export async function compactMessages(
  messages: Message[],
  provider: LLMProvider,
  model: string,
  maxTokens: number,
  options?: CompactionOptions,
): Promise<{ messages: Message[]; compacted: boolean }> {
  // Count total tokens in current messages (excludes base64 image data) + system/tool overhead.
  // Apply model-aware safety factor: 1.35x for Anthropic (tiktoken undercount), 1.0x for GPT/Codex.
  const safetyFactor = getSafetyFactor(model);
  const rawTokens = estimateTokens(messages, model) + (options?.overheadTokens ?? 0);
  const totalTokens = Math.ceil(rawTokens * safetyFactor);
  // Threshold from compactionThresholdFor — window-aware, proactive headroom
  // (operator 2026-07-24: overflow must not reach the provider; force=true when
  // the caller already decided via needsCompaction / reported prompt_tokens so
  // this tiktoken re-estimate cannot skip and strand the session on recovery).
  const threshold = maxTokens * compactionThresholdFor(maxTokens);

  // Compact if above the proactive threshold (unless forced by the gate)
  if (!options?.force && totalTokens < threshold) {
    return { messages, compacted: false };
  }

  // The compaction call itself is an API request: semantic prefix + prompt +
  // output budget must fit within the model's context window. Reserve space for
  // prompt + output, then choose the largest complete oldest prefix that fits.
  // Scale budgets proportionally for small contexts (local models with 4K-32K).
  // Provider-aware ceiling: slow local models (cortex/vllm/ollama/llamacpp) decode at
  // ~12-25 tok/s. A reasoning-model regression can consume the entire budget without
  // emitting summary text, so keep the local worst case bounded. 2K is enough for a
  // detailed summary and limits a saturated pass to ~80s at 25 tok/s (instead of the
  // live 8K / 328s failure); cloud models retain the 20K detail budget. Slug
  // prefixes are preserved through "auto" resolution.
  const isSlowLocalModel = isCortexModelId(model ?? '') || /^(vllm|ollama|llamacpp)\//i.test(model ?? '');
  const MAX_COMPACTION_OUTPUT = isSlowLocalModel
    ? parsePositiveIntEnv('SHIZUHA_LOCAL_COMPACTION_MAX_OUTPUT_TOKENS', 2048)
    : 20000;
  const COMPACTION_OUTPUT_BUDGET = Math.min(MAX_COMPACTION_OUTPUT, Math.floor(maxTokens * 0.3));
  const RETRY_OUTPUT_BUDGET = isSlowLocalModel
    ? Math.min(COMPACTION_OUTPUT_BUDGET, 1024)
    : COMPACTION_OUTPUT_BUDGET;
  const COMPACTION_PROMPT_RESERVE = Math.min(5000, Math.floor(maxTokens * 0.15));
  // The compaction request itself goes through the same provider context guard as
  // normal turns. Reserve that guard here too, otherwise a near-window transcript
  // can fail before compaction ever has a chance to produce a smaller history.
  const COMPACTION_PROVIDER_GUARD = maxTokens >= 64_000
    ? Math.min(16_000, Math.max(4096, Math.floor(maxTokens * 0.05)))
    : Math.min(1024, Math.max(256, Math.floor(maxTokens * 0.05)));
  // Compaction-input safety: Cortex/local model tokenizers are the riskiest because
  // JSON-heavy tool transcripts can be much denser than tiktoken predicts. Use
  // a wider factor than normal turn estimates and then verify in a loop below.
  const compactionInputSafetyFactor = isSlowLocalModel ? 1.75 : safetyFactor > 1.0 ? 1.5 : 1.1;
  const maxConversationTokens = Math.max(
    128,
    Math.floor((maxTokens - COMPACTION_OUTPUT_BUDGET - COMPACTION_PROMPT_RESERVE - COMPACTION_PROVIDER_GUARD) / compactionInputSafetyFactor),
  );
  const semanticPrefix = selectSemanticPrefix(messages, model, maxConversationTokens, maxTokens);
  const { conversationText, prefixEnd, conversationTokens } = semanticPrefix;
  logger.info(
    {
      rawTokens,
      totalTokens,
      threshold,
      messageCount: messages.length,
      summarizedPrefixMessages: prefixEnd,
      preservedSuffixMessages: messages.length - prefixEnd,
      conversationTokens,
      maxConversationTokens,
    },
    'Compacting oldest semantic prefix',
  );

  // Summarize using the LLM with larger budget for detail preservation
  let prompt = COMPACTION_PROMPT;
  if (options?.customInstructions) {
    prompt += `\n\nADDITIONAL FOCUS: ${options.customInstructions}`;
  }
  const summaryMessages: ChatMessage[] = [
    { role: 'user', content: `${prompt}\n\n---\n\n${conversationText}` },
  ];

  // Use 20000 max output tokens for compaction.
  // Disable thinking for compaction (not needed for summarization).
  // Use minimal system prompt (single-line summary instruction).
  let summary = '';
  let summaryChars = 0;
  let summaryReasoningChars = 0;
  let summaryOutputTokens = 0;
  let summaryStopReason = '';
  let finalSummary: string | undefined;
  if (options?.abortSignal?.aborted) {
    throw options.abortSignal.reason ?? new Error('Interrupted');
  }
  for await (const chunk of provider.chat(summaryMessages, {
    model,
    maxTokens: COMPACTION_OUTPUT_BUDGET,
    temperature: 0,
    thinkingLevel: 'off',
    systemPrompt: 'You are a helpful AI assistant tasked with summarizing conversations.',
    abortSignal: options?.abortSignal,
    // PLAT-4189: carry the agent's session id so the (large) compaction request
    // routes to the SAME warm backend the session already occupies — otherwise
    // cortex falls back to prompt-prefix hashing, lands the 200K+ context on a
    // cold replica, and re-prefills the whole thing (~140s backend_switch tail).
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    // 2026-07-14: tag as a maintenance call so Cortex logs its TTFT under the
    // separate compaction_ttft stage — a full-context prefill legitimately takes
    // minutes and must not pollute the interactive TTFT SLO.
    requestKind: 'compaction',
  })) {
    if (options?.abortSignal?.aborted) {
      throw options.abortSignal.reason ?? new Error('Interrupted');
    }
    if (chunk.type === 'text') {
      summary += chunk.text;
      summaryChars += chunk.text.length;
      options?.onProgress?.({ outputTokens: Math.round(summaryChars / 4), outputChars: summaryChars, budget: COMPACTION_OUTPUT_BUDGET, stage: 'summary' });
    }
    if (chunk.type === 'reasoning_text') summaryReasoningChars += chunk.text.length;
    if (chunk.type === 'usage') summaryOutputTokens = chunk.outputTokens;
    if (chunk.type === 'stop_reason') summaryStopReason = chunk.reason;
    if (chunk.type === 'final_text') finalSummary = chunk.text;
  }
  if (finalSummary) summary = finalSummary;

  // Extract content from <summary> tags if present (Claude Code format)
  const summaryMatch = summary.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    summary = summaryMatch[1]!.trim();
  }

  // ── Quality gate: retry if summary is suspiciously short ──
  // A 79-token summary for 464 messages means the API was degraded or the model
  // wasted output on <analysis> and got cut off before <summary>. Retry once with
  // a simpler prompt (no analysis/summary tags → all output goes to the summary).
  const MIN_SUMMARY_TOKENS = Math.min(200, Math.max(20, Math.floor(conversationTokens * 0.10)));
  const summaryTokenCount = countTokens(summary);
  const reasoningOnlyBudgetSaturation =
    isSlowLocalModel
    && summaryTokenCount < MIN_SUMMARY_TOKENS
    && summaryReasoningChars > 0
    && (
      summaryStopReason === 'max_tokens'
      || summaryOutputTokens >= Math.floor(COMPACTION_OUTPUT_BUDGET * 0.9)
    );
  if (reasoningOnlyBudgetSaturation) {
    logger.warn(
      {
        summaryTokens: summaryTokenCount,
        reasoningChars: summaryReasoningChars,
        outputTokens: summaryOutputTokens,
        stopReason: summaryStopReason,
        budget: COMPACTION_OUTPUT_BUDGET,
      },
      'Compaction exhausted its local-model budget in reasoning only — skipping futile retry',
    );
  }
  if (summaryTokenCount < MIN_SUMMARY_TOKENS && !reasoningOnlyBudgetSaturation) {
    logger.warn(
      { summaryTokens: summaryTokenCount, messageCount: messages.length, minRequired: MIN_SUMMARY_TOKENS },
      'Compaction summary suspiciously short — retrying with simpler prompt',
    );

    try {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error('Interrupted');
      }
      const retryPrompt = `Summarize this oldest coding-agent conversation prefix in detail. This summary REPLACES the provided prefix; a recent suffix will be appended verbatim.

Include ALL of the following:
- The original task and user's intent
- Every file path created/modified/read (FULL paths)
- Key code snippets verbatim (not just descriptions)
- Every error encountered with exact messages and how they were resolved
- What has been completed and what remains
- What the agent was doing most recently

Be thorough — a longer summary is far better than a short one.

---

${conversationText}`;
      const retryMessages: ChatMessage[] = [
        { role: 'user', content: retryPrompt },
      ];

      let retrySummary = '';
      let retryChars = 0;
      let retryFinalSummary: string | undefined;
      for await (const chunk of provider.chat(retryMessages, {
        model,
        maxTokens: RETRY_OUTPUT_BUDGET,
        temperature: 0,
        thinkingLevel: 'off',
        systemPrompt: 'You are a helpful AI assistant. Produce a detailed, comprehensive summary.',
        abortSignal: options?.abortSignal,
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        requestKind: 'compaction',
      })) {
        if (options?.abortSignal?.aborted) break;
        if (chunk.type === 'text') {
          retrySummary += chunk.text;
          retryChars += chunk.text.length;
          options?.onProgress?.({ outputTokens: Math.round(retryChars / 4), outputChars: retryChars, budget: RETRY_OUTPUT_BUDGET, stage: 'retry' });
        }
        if (chunk.type === 'final_text') retryFinalSummary = chunk.text;
      }
      if (retryFinalSummary) retrySummary = retryFinalSummary;

      const retryTokenCount = countTokens(retrySummary);
      if (retryTokenCount > summaryTokenCount) {
        logger.info(
          { originalTokens: summaryTokenCount, retryTokens: retryTokenCount },
          'Compaction retry produced better summary — using retry',
        );
        summary = retrySummary;
      } else {
        logger.warn(
          { originalTokens: summaryTokenCount, retryTokens: retryTokenCount },
          'Compaction retry did not improve — using original',
        );
      }
    } catch (retryErr) {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? retryErr;
      }
      logger.warn(
        { error: (retryErr as Error).message, summaryTokens: summaryTokenCount },
        'Compaction retry failed — using original short summary',
      );
    }
  }

  // ── Quality verdict + the forced-compaction fallback ladder ──
  // Optional maintenance paths fail fast on any quality problem (safe: they
  // retry next turn). MANDATORY compactions (resume of an over-window session,
  // forced maintenance) must NEVER dead-end the session — shizuha5 2026-08-10
  // hit BOTH branches on consecutive attempts ('121/200 tokens', then
  // 'echoed_serialized_tool_blocks') and each left the session UNRESUMABLE.
  // Ladder under force: accept short-but-real → sanitize echoed machinery out
  // and accept the residue → deterministic extractive fallback. The last rung
  // always succeeds, so a forced compaction cannot fail on summary quality.
  // Hard floor even under force: a 2-token "OK" is not a summary; the
  // historical lower bound (20 tokens) separates terse-but-real from junk.
  const FORCED_ACCEPT_FLOOR_TOKENS = 20;
  const summaryQualityFailure = (text: string): string | null => {
    if (countTokens(text, model) < MIN_SUMMARY_TOKENS) {
      return `too short (${countTokens(text, model)}/${MIN_SUMMARY_TOKENS} tokens)`;
    }
    // Length alone let a non-summary through (2026-08-04): the model echoed a
    // raw tool_use block and talked about the PREVIOUS summary instead of the
    // work. Long enough is not good enough — check what it actually contains.
    const verdict = isDegenerateSummary(text);
    return verdict.degenerate ? verdict.reason : null;
  };
  const forcedAcceptable = (text: string): boolean =>
    countTokens(text, model) >= FORCED_ACCEPT_FLOOR_TOKENS
    && !isDegenerateSummary(text).degenerate;

  const qualityFailure = summaryQualityFailure(summary);
  if (qualityFailure) {
    if (!options?.force) {
      throw new CompactionQualityError(
        `Semantic compaction summary failed quality checks: ${qualityFailure}`,
      );
    }
    if (forcedAcceptable(summary)) {
      logger.warn(
        { summaryTokens: countTokens(summary, model), reason: qualityFailure },
        'Semantic compaction summary below quality bar — accepting best effort for forced compaction',
      );
    } else {
      const sanitized = stripEchoedToolBlocks(summary);
      if (forcedAcceptable(sanitized)) {
        logger.warn(
          { reason: qualityFailure, before: summary.length, after: sanitized.length },
          'Semantic compaction summary sanitized (echoed machinery stripped) — accepting for forced compaction',
        );
        summary = sanitized;
      } else {
        // Last rung — must never fail. Extractive truncation was removed
        // deliberately (8f6ba0dc: destructive mid-history collapse ate
        // working context), so the guaranteed floor is the envelope itself:
        // projectCompactedMessages prepends the task anchor + current task
        // headings and preserves the full recent suffix verbatim. The summary
        // body degrades to whatever sanitized prose survived, or an explicit
        // notice. Imperfect, loudly logged, and strictly better than an
        // unresumable session.
        summary = sanitized.trim()
          || 'Summary unavailable: the model returned no usable summary for the '
          + 'compacted prefix. Recover task state from the task anchor above, '
          + 'the preserved recent messages below, and persistent notes.';
        logger.warn(
          { reason: qualityFailure, fallbackChars: summary.length },
          'Semantic compaction summary unusable — degrading to anchor-envelope fallback (forced)',
        );
      }
    }
  }

  const compacted = projectCompactedMessages(messages, summary, prefixEnd, options);
  const compactedTokens = Math.ceil(
    (estimateTokens(compacted, model) + (options?.overheadTokens ?? 0)) * safetyFactor,
  );
  if (compactedTokens >= totalTokens && !options?.allowNonReducing) {
    throw new CompactionCapacityError(
      `Semantic compaction did not reduce the working context (${totalTokens} -> ${compactedTokens} tokens)`,
    );
  }
  const outputReserve = Math.min(16_384, Math.floor(maxTokens * 0.15));
  const messagesBudget = Math.min(
    maxTokens - outputReserve,
    options?.targetFinalTokens ?? Number.POSITIVE_INFINITY,
  );
  if (compactedTokens > messagesBudget) {
    const semanticPass = options?.semanticPass ?? 0;
    logger.info(
      {
        semanticPass: semanticPass + 1,
        compactedTokens,
        messagesBudget,
        preservedSuffixMessages: messages.length - prefixEnd,
      },
      'Semantic projection still oversized — compacting its oldest prefix in another model pass',
    );
    return compactMessages(compacted, provider, model, maxTokens, {
      ...options,
      force: true,
      semanticPass: semanticPass + 1,
    });
  }
  logger.info(
    {
      originalMessages: messages.length,
      compactedMessages: compacted.length,
      summarizedPrefixMessages: prefixEnd,
      preservedSuffixMessages: messages.length - prefixEnd,
      summaryTokens: countTokens(summary, model),
    },
    'Compaction complete',
  );
  return { messages: compacted, compacted: true };
}

/**
 * Required semantic compaction. Missing providers and provider failures are
 * terminal to this maintenance attempt: callers retain their prior projection
 * and retry or surface the failure, never substitute deterministic history.
 */
export async function compactMessagesRequired(
  messages: Message[],
  provider: LLMProvider | null | undefined,
  model: string,
  maxTokens: number,
  options?: CompactionOptions,
): Promise<{ messages: Message[]; compacted: boolean }> {
  if (!provider) {
    throw new CompactionCapacityError('No model provider is available for required semantic compaction');
  }
  return compactMessages(messages, provider, model, maxTokens, options);
}
