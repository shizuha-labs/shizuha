import type { Message, ToolCall, ContentBlock } from './types.js';
import type { LLMProvider, ChatMessage, ChatContentBlock, StreamChunk } from '../provider/types.js';
import type { ToolHandler, ToolResult, ToolContext, ToolDefinition } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionEngine } from '../permissions/engine.js';
import type { AgentEventEmitter } from '../events/emitter.js';
import type { HookEngine } from '../hooks/engine.js';
import type { BackgroundTaskRegistry } from '../tasks/registry.js';
import { logger } from '../utils/logger.js';

/** Callback for interactive permission approval (TUI) */
export type PermissionAskCallback = (
  toolName: string,
  input: Record<string, unknown>,
  riskLevel: 'low' | 'medium' | 'high',
) => Promise<'allow' | 'deny' | 'allow_always'>;

export interface TurnResult {
  assistantMessage: Message;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** Convert agent messages to chat messages for the LLM */
export function messagesToChat(messages: Message[]): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content } as ChatMessage;
    }
    const blocks = (m.content as ContentBlock[]).map((b): ChatContentBlock => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      if (b.type === 'reasoning') return { type: 'reasoning', id: b.id, encryptedContent: b.encryptedContent, signature: b.signature, summary: b.summary };
      return { type: 'tool_result', toolUseId: b.toolUseId, content: b.content, isError: b.isError, image: b.image };
    });
    return { role: m.role, content: blocks } as ChatMessage;
  });
}

/** Max concurrent read-only tools to execute during streaming */
const MAX_CONCURRENT_STREAMING_TOOLS = 8;

/** Execute a single turn: send messages to LLM, stream response, execute tool calls.
 *
 * Read-only tools start executing as soon as their input is complete during streaming,
 * overlapping API latency with tool execution. Write tools execute sequentially after
 * streaming completes.
 */
export async function executeTurn(
  messages: Message[],
  provider: LLMProvider,
  model: string,
  systemPrompt: string,
  toolDefs: ToolDefinition[],
  toolRegistry: ToolRegistry,
  permissions: PermissionEngine,
  emitter: AgentEventEmitter,
  context: ToolContext,
  maxOutputTokens: number,
  temperature: number,
  onPermissionAsk?: PermissionAskCallback,
  hookEngine?: HookEngine,
  thinkingLevel?: string,
  abortSignal?: AbortSignal,
  reasoningEffort?: string,
  fastMode?: boolean,
): Promise<TurnResult> {
  // Inject background task status/progress before this turn's API call.
  // This is the push-notification mechanism — completed tasks get surfaced
  // as system-reminder messages so the model knows without polling.
  if (context.taskRegistry) {
    const attachments = context.taskRegistry.collectAttachments();
    for (const att of attachments) {
      let text: string;
      if (att.type === 'task_status') {
        const parts = [
          `Background task ${att.taskId} (${att.taskType}) has ${att.status}.`,
          `Description: ${att.description}`,
        ];
        if (att.deltaOutput) parts.push(`Output:\n${att.deltaOutput}`);
        if (att.error) parts.push(`Error: ${att.error}`);
        parts.push('You can read the full output using the TaskOutput tool.');
        text = parts.join('\n');
      } else {
        text = `Background task ${att.taskId} (${att.taskType}) is still running: ${att.description}`;
        if (att.deltaOutput) text += `\nRecent output:\n${att.deltaOutput}`;
      }
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `<system-reminder>${text}</system-reminder>` }],
        timestamp: Date.now(),
      });
    }
  }

  const chatMessages = messagesToChat(messages);

  // Stream LLM response
  let text = '';
  let finalText: string | undefined;
  const toolCalls: ToolCall[] = [];
  const reasoningBlocks: Array<{ id: string; encryptedContent?: string | null; signature?: string; summary?: Array<{ text: string }> }> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | undefined;
  let cacheCreationInputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;

  const pendingToolInputs = new Map<string, { name: string; inputStr: string }>();

  // Track in-flight read-only tool executions started during streaming
  const inflightResults = new Map<string, Promise<ToolResult>>(); // toolCallId → promise
  let inflightCount = 0;

  let streamAborted = false;
  let _yieldCounter = 0;
  try {
    for await (const chunk of provider.chat(chatMessages, {
      model,
      systemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: maxOutputTokens,
      temperature,
      ...(thinkingLevel && thinkingLevel !== 'off' ? { thinkingLevel } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fastMode ? { serviceTier: 'priority' as const } : {}),
      abortSignal,
    })) {
      // Check abort signal — break out of streaming immediately
      if (abortSignal?.aborted) { streamAborted = true; break; }

      // Yield control periodically to prevent event loop starvation
      // This allows stdin events (Ctrl+C) to be processed during streaming
      if (++_yieldCounter % 5 === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }

      switch (chunk.type) {
        case 'text':
          text += chunk.text;
          emitter.emit({ type: 'content', text: chunk.text, timestamp: Date.now() });
          break;

        case 'final_text':
          finalText = chunk.text;
          break;

        case 'tool_use_start':
          pendingToolInputs.set(chunk.id, { name: chunk.name, inputStr: '' });
          emitter.emit({
            type: 'tool_start',
            toolCallId: chunk.id,
            toolName: chunk.name,
            input: {},
            timestamp: Date.now(),
          });
          break;

        case 'tool_use_delta': {
          const pending = pendingToolInputs.get(chunk.id);
          if (pending) pending.inputStr += chunk.input;
          break;
        }

        case 'tool_use_end': {
          const pending = pendingToolInputs.get(chunk.id);
          const tc: ToolCall = {
            id: chunk.id,
            name: pending?.name ?? '',
            input: chunk.input,
          };
          toolCalls.push(tc);
          pendingToolInputs.delete(chunk.id);

          // Re-emit tool_start with the complete input so the TUI can display
          // tool arguments (file_path, pattern, etc). The initial tool_start
          // at tool_use_start time has input:{} because input streams incrementally.
          // The TUI handler merges duplicates by toolCallId.
          emitter.emit({
            type: 'tool_start',
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.input,
            timestamp: Date.now(),
          });

          // Start read-only tools immediately during streaming (up to concurrency limit)
          const handler = toolRegistry.get(tc.name);
          if (handler?.readOnly && inflightCount < MAX_CONCURRENT_STREAMING_TOOLS) {
            inflightCount++;
            const promise = executeToolCall(tc, toolRegistry, permissions, emitter, context, onPermissionAsk, hookEngine)
              .finally(() => { inflightCount--; });
            inflightResults.set(tc.id, promise);
          }
          break;
        }

        case 'web_search': {
          const wsId = `ws-${Date.now()}`;
          emitter.emit({ type: 'tool_start', toolCallId: wsId, toolName: 'web_search', input: {}, timestamp: Date.now() });
          if (chunk.status === 'done') {
            emitter.emit({ type: 'tool_complete', toolCallId: wsId, toolName: 'web_search', result: 'Search complete', isError: false, durationMs: 0, timestamp: Date.now() });
          }
          break;
        }

        case 'thinking':
          // Heartbeat from provider during extended thinking — emit so TUI resets stall timer
          emitter.emit({ type: 'thinking', timestamp: Date.now() });
          break;

        case 'reasoning_text':
          // Streaming reasoning summary text — forward to TUI/CLI for live thinking display
          emitter.emit({ type: 'reasoning_text', text: chunk.text, timestamp: Date.now() });
          break;

        case 'reasoning':
          reasoningBlocks.push({
            id: chunk.id,
            encryptedContent: chunk.encryptedContent,
            signature: chunk.signature,
            summary: chunk.summary,
          });
          // Emit reasoning summaries to TUI
          if (chunk.summary?.length) {
            const summaryTexts = chunk.summary.map((s) => s.text).filter(Boolean);
            if (summaryTexts.length > 0) {
              emitter.emit({ type: 'reasoning', summaries: summaryTexts, timestamp: Date.now() });
            }
          }
          break;

        case 'usage':
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
          if (chunk.cacheCreationInputTokens != null) cacheCreationInputTokens = chunk.cacheCreationInputTokens;
          if (chunk.cacheReadInputTokens != null) cacheReadInputTokens = chunk.cacheReadInputTokens;
          break;

        case 'stop_reason':
          stopReason = chunk.reason;
          break;

        case 'done':
          break;
      }
    }
  } catch (err) {
    // Abort fires during streaming — provider throws AbortError.
    // Catch it and return a partial result instead of propagating.
    if (abortSignal?.aborted) {
      streamAborted = true;
    } else {
      throw err;
    }
  }

  // On stream abort: return partial result (text only, no orphaned tool_use blocks)
  if (streamAborted) {
    const partialMsg: Message = {
      role: 'assistant',
      content: text || '(interrupted)',
      timestamp: Date.now(),
    };
    return {
      assistantMessage: partialMsg,
      toolCalls: [],
      toolResults: [],
      inputTokens,
      outputTokens,
      stopReason: 'interrupted',
    };
  }

  // Build assistant message
  const contentBlocks: ContentBlock[] = [];
  const assistantText = finalText ?? text;
  // Reasoning items first (for roundtripping encrypted content)
  for (const rb of reasoningBlocks) {
    contentBlocks.push({ type: 'reasoning', id: rb.id, encryptedContent: rb.encryptedContent, signature: rb.signature, summary: rb.summary });
  }
  if (assistantText) contentBlocks.push({ type: 'text', text: assistantText });
  for (const tc of toolCalls) {
    contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  const assistantMessage: Message = {
    role: 'assistant',
    content: contentBlocks.length === 1 && contentBlocks[0]!.type === 'text'
      ? (contentBlocks[0] as { text: string }).text
      : contentBlocks,
    timestamp: Date.now(),
  };

  // Execute tool calls — some read-only tools may already be in-flight from streaming
  const resultMap = new Map<string, ToolResult>();

  if (toolCalls.length > 0) {
    // Separate remaining read-only (not yet started) from write tools
    const remainingReadOnly: ToolCall[] = [];
    const writeCalls: ToolCall[] = [];

    for (const tc of toolCalls) {
      if (inflightResults.has(tc.id)) continue; // already started during streaming
      const handler = toolRegistry.get(tc.name);
      if (handler?.readOnly) {
        remainingReadOnly.push(tc);
      } else {
        writeCalls.push(tc);
      }
    }

    // Await all in-flight results from streaming
    const inflightEntries = [...inflightResults.entries()];
    const inflightSettled = await Promise.all(inflightEntries.map(([, p]) => p));
    for (let i = 0; i < inflightEntries.length; i++) {
      resultMap.set(inflightEntries[i]![0], inflightSettled[i]!);
    }

    // Execute remaining read-only tools in parallel
    if (remainingReadOnly.length > 0) {
      const results = await Promise.all(
        remainingReadOnly.map((tc) => executeToolCall(tc, toolRegistry, permissions, emitter, context, onPermissionAsk, hookEngine)),
      );
      for (let i = 0; i < remainingReadOnly.length; i++) {
        resultMap.set(remainingReadOnly[i]!.id, results[i]!);
      }
    }

    // Execute write tools sequentially
    for (const tc of writeCalls) {
      const result = await executeToolCall(tc, toolRegistry, permissions, emitter, context, onPermissionAsk, hookEngine);
      resultMap.set(tc.id, result);
    }
  }

  // Sort results to match original tool call order
  const toolResults: ToolResult[] = toolCalls
    .map((tc) => resultMap.get(tc.id))
    .filter((r): r is ToolResult => r !== undefined);

  return { assistantMessage, toolCalls, toolResults, inputTokens, outputTokens, stopReason, cacheCreationInputTokens, cacheReadInputTokens };
}

async function executeToolCall(
  tc: ToolCall,
  registry: ToolRegistry,
  permissions: PermissionEngine,
  emitter: AgentEventEmitter,
  context: ToolContext,
  onPermissionAsk?: PermissionAskCallback,
  hookEngine?: HookEngine,
): Promise<ToolResult> {
  const startTime = Date.now();
  const handler = registry.get(tc.name);

  if (!handler) {
    const result: ToolResult = {
      toolUseId: tc.id,
      content: `Unknown tool: ${tc.name}`,
      isError: true,
    };
    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return result;
  }

  // Check permissions
  const decision = permissions.check({
    toolName: tc.name,
    input: tc.input,
    riskLevel: handler.riskLevel,
  });

  if (decision === 'deny') {
    const result: ToolResult = {
      toolUseId: tc.id,
      content: `Permission denied for tool "${tc.name}" in current mode.`,
      isError: true,
    };
    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return result;
  }

  // Interactive approval for 'ask' decision
  if (decision === 'ask' && onPermissionAsk) {
    const approval = await onPermissionAsk(tc.name, tc.input, handler.riskLevel);
    if (approval === 'deny') {
      const result: ToolResult = {
        toolUseId: tc.id,
        content: `User denied permission for tool "${tc.name}".`,
        isError: true,
      };
      emitter.emit({
        type: 'tool_complete',
        toolCallId: tc.id,
        toolName: tc.name,
        result: result.content,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
      return result;
    }
    if (approval === 'allow_always') {
      permissions.approve(tc.name);
    }
  }

  // PreToolUse hooks — can block execution
  if (hookEngine?.hasHooks('PreToolUse')) {
    const hookEnv: Record<string, string> = {
      TOOL_NAME: tc.name,
      TOOL_INPUT: JSON.stringify(tc.input),
      SESSION_ID: context.sessionId,
      CWD: context.cwd,
    };
    const hookResults = await hookEngine.runHooks('PreToolUse', hookEnv, tc.name);
    const blocked = hookResults.find((r) => r.blocked);
    if (blocked) {
      const result: ToolResult = {
        toolUseId: tc.id,
        content: `Blocked by hook: ${blocked.blockReason ?? 'PreToolUse hook returned exit code 2'}`,
        isError: true,
      };
      emitter.emit({
        type: 'tool_complete',
        toolCallId: tc.id,
        toolName: tc.name,
        result: result.content,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
      return result;
    }
  }

  // Execute — provide onProgress callback for streaming tool output
  const toolContext: ToolContext = {
    ...context,
    onProgress: (text: string) => {
      emitter.emit({
        type: 'tool_progress',
        toolCallId: tc.id,
        toolName: tc.name,
        output: text,
        timestamp: Date.now(),
      });
    },
  };
  try {
    const result = await handler.execute(tc.input, toolContext);
    result.toolUseId = tc.id;

    // PostToolUse hooks
    if (hookEngine?.hasHooks('PostToolUse')) {
      const hookEnv: Record<string, string> = {
        TOOL_NAME: tc.name,
        TOOL_INPUT: JSON.stringify(tc.input),
        TOOL_RESULT: result.content,
        TOOL_ERROR: String(result.isError ?? false),
        SESSION_ID: context.sessionId,
        CWD: context.cwd,
      };
      await hookEngine.runHooks('PostToolUse', hookEnv, tc.name);
    }

    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: result.isError ?? false,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
      metadata: result.metadata,
      ...(result.image ? { image: result.image } : {}),
      ...(result.metadata?.audio ? { audio: result.metadata.audio as { base64: string; format: string; mimeType: string } } : {}),
    });
    return result;
  } catch (err) {
    const result: ToolResult = {
      toolUseId: tc.id,
      content: `Tool error: ${(err as Error).message}`,
      isError: true,
    };
    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return result;
  }
}
