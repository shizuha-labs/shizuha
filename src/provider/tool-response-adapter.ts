/**
 * Tool response adapters — model-specific overrides for tool result formatting.
 *
 * Core tool improvements (edit context, todo nudge, bash exit code) live in the
 * tools themselves. This module only handles model-specific formatting that goes
 * BEYOND the core — e.g., exact phrasing or <system-reminder> tags that a model
 * was trained on.
 *
 * Adapters are keyed by format name (from ModelProfile.toolResponseFormat)
 * and indexed by tool name.
 */

import * as path from 'node:path';

interface AdapterContext {
  content: string;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  isError?: boolean;
}

type ToolAdapter = (ctx: AdapterContext) => string;

// ── qwen-code format adapters (model-specific overrides only) ──

const qwenCodeAdapters: Record<string, ToolAdapter> = {
  // todo_write: Wrap in qwen-code's exact <system-reminder> format
  // The core already adds a generic continuation nudge, but the model was
  // specifically trained on this XML-tagged format with JSON todo dump.
  todo_write(ctx) {
    if (ctx.isError) return ctx.content;
    const rawTodos = ctx.metadata?.rawTodos as Array<{ id: string; content: string; status: string }> | undefined;
    const todosJson = rawTodos ? JSON.stringify(rawTodos) : '[]';
    return (
      'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable\n\n' +
      '<system-reminder>\n' +
      'Your todo list has changed. DO NOT mention this explicitly to the user. Here are the latest contents of your todo list: \n\n' +
      todosJson + '. Continue on with the tasks at hand if applicable.\n' +
      '</system-reminder>'
    );
  },

  // write_file: Exact qwen-code phrasing (model trained on this)
  write_file(ctx) {
    if (ctx.isError) return ctx.content;
    const filePath = ctx.metadata?.filePath ?? ctx.input.file_path ?? ctx.input.path ?? '';
    const isNew = ctx.metadata?.isNew !== false;
    return isNew
      ? `Successfully created and wrote to new file: ${filePath}.`
      : `Successfully overwrote file: ${filePath}.`;
  },

  // edit: Override core's format with qwen-code's exact format
  edit(ctx) {
    if (ctx.isError) return ctx.content;
    const filePath = (ctx.metadata?.filePath ?? ctx.input.file_path ?? '') as string;
    const newContent = ctx.metadata?.newContent as string | undefined;
    if (!filePath || !newContent) return ctx.content;

    const lines = newContent.split('\n');
    const totalLines = lines.length;
    const newStr = (ctx.input.new_string ?? '') as string;
    const idx = newContent.indexOf(newStr);
    const editLine = idx >= 0 ? newContent.slice(0, idx).split('\n').length - 1 : 0;
    const startLine = Math.max(0, editLine - 5);
    const endLine = Math.min(totalLines, editLine + newStr.split('\n').length + 10);
    const contextLines = lines.slice(startLine, endLine).join('\n');

    return (
      `The file: ${filePath} has been updated. Showing lines ${startLine + 1}-${endLine} of ${totalLines} from the edited file:\n\n` +
      '---\n\n' +
      contextLines
    );
  },

  // run_shell_command / bash: Strip the appended "Exit code: N" that core adds,
  // since qwen-code only shows exit code implicitly via isError flag.
  run_shell_command(ctx) {
    // Remove the "\n\nExit code: N" suffix added by core bash tool
    return ctx.content.replace(/\n\nExit code: \d+$/, '');
  },

  // read_file: Prefix with qwen-code's exact line info format
  read_file(ctx) {
    if (ctx.isError) return ctx.content;
    const filePath = (ctx.input.file_path ?? ctx.input.path ?? '') as string;
    const fileName = path.basename(filePath as string);
    const content = ctx.content;
    const totalLines = content.split('\n').length;

    const offset = (ctx.input.offset as number) ?? 1;
    const limit = (ctx.input.limit as number) ?? totalLines;
    const endLine = Math.min(offset + limit - 1, totalLines);

    return `Read lines ${offset}-${endLine} of ${totalLines} from ${fileName}\n\n${content}`;
  },
};

// ── Format registry ──

const FORMAT_REGISTRY: Record<string, Record<string, ToolAdapter>> = {
  'qwen-code': qwenCodeAdapters,
};

/**
 * Apply tool response adapter if one exists for the given format and tool.
 * Returns the original content if no adapter matches.
 */
export function adaptToolResult(
  format: string | undefined,
  toolName: string,
  content: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  isError?: boolean,
): string {
  if (!format) return content;
  const adapters = FORMAT_REGISTRY[format];
  if (!adapters) return content;
  const adapter = adapters[toolName];
  if (!adapter) return content;
  return adapter({ content, input, metadata, isError });
}

/**
 * Coerce string values to numbers for known numeric tool parameters.
 * Fixes models that send "30000" instead of 30000 for timeout fields.
 */
export function coerceToolParams(input: Record<string, unknown>): Record<string, unknown> {
  const NUMERIC_FIELDS = new Set(['timeout', 'timeout_seconds', 'limit', 'offset', 'max_lines', 'context_lines']);
  const result = { ...input };
  for (const key of NUMERIC_FIELDS) {
    if (key in result && typeof result[key] === 'string') {
      const num = Number(result[key]);
      if (!isNaN(num)) result[key] = num;
    }
  }
  return result;
}
