import * as fs from 'node:fs';
import type { Message, ContentBlock, ToolResultContent } from '../agent/types.js';
import type { LLMProvider, ChatMessage } from '../provider/types.js';
import { countTokens } from '../utils/tokens.js';
import { estimateTokens, getSafetyFactor } from '../prompt/context.js';
import { logger } from '../utils/logger.js';

// Compaction prompt modeled after Claude Code's 9-section format (node-forge.js:15447-15550)
const COMPACTION_PROMPT = `You are a conversation compactor for a coding agent. Analyze the conversation and produce a detailed summary.

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

CRITICAL: This summary replaces the full conversation history. The agent will use ONLY this summary to continue working. If you omit test failures, file paths, error messages, or code state, the agent will repeat work or miss bugs. A longer, complete summary is far better than a short, lossy one.`;

/**
 * Single-pass context compaction. When context exceeds threshold,
 * summarize the conversation using the LLM and replace the message history.
 */
export async function compactMessages(
  messages: Message[],
  provider: LLMProvider,
  model: string,
  maxTokens: number,
  options?: { force?: boolean; customInstructions?: string; abortSignal?: AbortSignal; overheadTokens?: number; planFilePath?: string },
): Promise<{ messages: Message[]; compacted: boolean }> {
  // Count total tokens in current messages (excludes base64 image data) + system/tool overhead.
  // Apply model-aware safety factor: 1.35x for Anthropic (tiktoken undercount), 1.0x for GPT/Codex.
  const safetyFactor = getSafetyFactor(model);
  const rawTokens = estimateTokens(messages, model) + (options?.overheadTokens ?? 0);
  const totalTokens = Math.ceil(rawTokens * safetyFactor);
  const threshold = maxTokens * 0.90;

  // Compact if above 90% of max (unless forced)
  if (!options?.force && totalTokens < threshold) {
    return { messages, compacted: false };
  }

  logger.info({ rawTokens, totalTokens, threshold, messageCount: messages.length }, 'Compacting context');

  // Build conversation text for summarization (strip base64 image data and encrypted content)
  let conversationText = messages
    .map((m) => {
      if (typeof m.content === 'string') {
        return `[${m.role}]: ${m.content}`;
      }
      // Serialize content blocks but replace binary/encrypted data with placeholders
      const blocks = (m.content as ContentBlock[]).map((b) => {
        if (b.type === 'tool_result') {
          const tr = b as ToolResultContent;
          if (tr.image) {
            return { type: tr.type, toolUseId: tr.toolUseId, content: tr.content, isError: tr.isError, image: '[image data omitted]' };
          }
        }
        if (b.type === 'reasoning') {
          // Strip encrypted content from reasoning blocks — it's opaque binary that
          // the summarizer can't read. Keep only the human-readable summary.
          const rb = b as { id: string; summary?: Array<{ text: string }>; encryptedContent?: string };
          const summaryText = rb.summary?.map((s) => s.text).filter(Boolean).join(' ') || '[thinking]';
          return { type: 'reasoning', summary: summaryText };
        }
        return b;
      });
      return `[${m.role}]: ${JSON.stringify(blocks)}`;
    })
    .join('\n\n');

  // ── Truncate conversation text if it would overflow the compaction call ──
  // The compaction call itself is an API request: conversation text + prompt + output budget
  // must fit within the model's context window. Reserve space for prompt + output.
  // Scale budgets proportionally for small contexts (local models with 4K-32K).
  const COMPACTION_OUTPUT_BUDGET = Math.min(20000, Math.floor(maxTokens * 0.3));
  const COMPACTION_PROMPT_RESERVE = Math.min(5000, Math.floor(maxTokens * 0.15));
  // Truncation safety: 1.5x for Anthropic (tiktoken gap + margin), 1.1x for GPT/Codex (small margin)
  const truncationSafetyFactor = safetyFactor > 1.0 ? 1.5 : 1.1;
  const maxConversationTokens = maxTokens - COMPACTION_OUTPUT_BUDGET - COMPACTION_PROMPT_RESERVE;
  const rawConversationTokens = countTokens(conversationText);
  const conversationTokens = Math.ceil(rawConversationTokens * truncationSafetyFactor);
  if (conversationTokens > maxConversationTokens) {
    // Truncate: keep first 25% (task context) + last 75% (recent work) of the token budget
    const ratio = maxConversationTokens / conversationTokens;
    const totalChars = conversationText.length;
    const keepChars = Math.floor(totalChars * ratio);
    const headChars = Math.floor(keepChars * 0.25);
    const tailChars = keepChars - headChars;
    const droppedTokens = conversationTokens - maxConversationTokens;
    conversationText = conversationText.slice(0, headChars)
      + `\n\n[... ${droppedTokens} tokens of middle context omitted to fit compaction budget ...]\n\n`
      + conversationText.slice(totalChars - tailChars);
    logger.info({ rawConversationTokens, conversationTokens, maxConversationTokens, droppedTokens }, 'Truncated conversation for compaction');
  }

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
  })) {
    if (options?.abortSignal?.aborted) {
      throw options.abortSignal.reason ?? new Error('Interrupted');
    }
    if (chunk.type === 'text') summary += chunk.text;
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
  const MIN_SUMMARY_TOKENS = 200;
  const summaryTokenCount = countTokens(summary);
  if (summaryTokenCount < MIN_SUMMARY_TOKENS && messages.length > 10) {
    logger.warn(
      { summaryTokens: summaryTokenCount, messageCount: messages.length, minRequired: MIN_SUMMARY_TOKENS },
      'Compaction summary suspiciously short — retrying with simpler prompt',
    );

    try {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error('Interrupted');
      }
      const retryPrompt = `Summarize this coding agent conversation in detail. This summary REPLACES the full conversation — the agent will ONLY have this summary to continue working.

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
      let retryFinalSummary: string | undefined;
      for await (const chunk of provider.chat(retryMessages, {
        model,
        maxTokens: COMPACTION_OUTPUT_BUDGET,
        temperature: 0,
        thinkingLevel: 'off',
        systemPrompt: 'You are a helpful AI assistant. Produce a detailed, comprehensive summary.',
        abortSignal: options?.abortSignal,
      })) {
        if (options?.abortSignal?.aborted) break;
        if (chunk.type === 'text') retrySummary += chunk.text;
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
      logger.warn(
        { error: (retryErr as Error).message, summaryTokens: summaryTokenCount },
        'Compaction retry failed — using original short summary',
      );
    }
  }

  // Replace with compacted messages: summary + recent messages
  const compacted: Message[] = [
    {
      role: 'user',
      content: `[Conversation Summary]\n${summary}`,
      timestamp: Date.now(),
    },
    {
      role: 'assistant',
      content: 'I have the full context from the conversation summary. Continuing the task.',
      timestamp: Date.now(),
    },
  ];

  // Keep last 4 messages for continuity, but don't split tool_use/tool_result pairs.
  // Walk backward to find a clean boundary (a user message that isn't a tool_result).
  let keepFrom = messages.length - 4;
  if (keepFrom < 0) keepFrom = 0;

  // Ensure we don't start in the middle of a tool_use → tool_result pair:
  // If keepFrom points to a user message with tool_result content, include the preceding assistant too.
  while (keepFrom > 0) {
    const msg = messages[keepFrom];
    if (!msg) break;
    const isToolResult = Array.isArray(msg.content)
      && (msg.content as ContentBlock[]).some((b) => b.type === 'tool_result');
    if (isToolResult) {
      keepFrom--; // include the assistant message with tool_use blocks
    } else {
      break;
    }
  }

  const recent = messages.slice(keepFrom);

  // ── Post-compaction safety net: truncate oversized tool results in recent messages ──
  // Without this, the "recent" messages can contain 1M+ tokens of tool results
  // (e.g., huge bash output, file reads) which makes the compacted context STILL exceed
  // the window. Trim oversized tool results to fit.
  const MAX_TOOL_RESULT_CHARS = 20000; // ~5K tokens — large enough for useful context
  for (const msg of recent) {
    if (!Array.isArray(msg.content)) continue;
    const blocks = msg.content as ContentBlock[];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (b.type === 'tool_result') {
        const tr = b as ToolResultContent;
        if (tr.content && tr.content.length > MAX_TOOL_RESULT_CHARS) {
          const original = tr.content.length;
          // Keep first 25% + last 75% (recent output is usually more relevant)
          const headChars = Math.floor(MAX_TOOL_RESULT_CHARS * 0.25);
          const tailChars = MAX_TOOL_RESULT_CHARS - headChars;
          tr.content = tr.content.slice(0, headChars)
            + `\n\n[... ${Math.ceil((original - MAX_TOOL_RESULT_CHARS) / 4)} tokens of output truncated after compaction ...]\n\n`
            + tr.content.slice(original - tailChars);
          logger.info({ originalChars: original, truncatedTo: tr.content.length }, 'Truncated oversized tool result after compaction');
        }
      }
      // Strip encrypted reasoning content from recent messages — it's been summarized
      if (b.type === 'reasoning') {
        const rb = b as { encryptedContent?: string | null; signature?: string; summary?: Array<{ text: string }> };
        if (rb.encryptedContent) {
          rb.encryptedContent = null;
          rb.signature = undefined;
        }
      }
    }
  }

  compacted.push(...recent);

  // Preserve plan file content after compaction
  if (options?.planFilePath) {
    try {
      const planContent = fs.readFileSync(options.planFilePath, 'utf-8');
      if (planContent.trim()) {
        // Inject as a user message so the agent remembers the plan
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
      // Plan file doesn't exist or can't be read — skip silently
    }
  }

  logger.info(
    { originalMessages: messages.length, compactedMessages: compacted.length, keptRecent: recent.length, summaryTokens: countTokens(summary) },
    'Compaction complete',
  );

  return { messages: compacted, compacted: true };
}
