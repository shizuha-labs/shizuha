import { DYNAMIC_BOUNDARY_MARKER } from './builder.js';

export const DEFERRED_TOOL_INSTRUCTIONS = '\n\n## More Tools (via ToolSearch)\n'
  + 'Additional MCP tools are available but withheld here to keep your context lean. '
  + 'Use ToolSearch with a keyword query (e.g. "wiki create page", "pulse transition") '
  + 'or "select:<exact_tool_name>" to find and load the tool you need before calling it.';

export function authoredCustomInstructions(systemPrompt: string): string {
  const separator = '\n\n---\n\n';
  const boundary = systemPrompt.indexOf(`${separator}${DYNAMIC_BOUNDARY_MARKER}${separator}`);
  const staticPrompt = boundary < 0 ? systemPrompt : systemPrompt.slice(0, boundary);
  const heading = '## Custom Instructions\n\n';
  const start = staticPrompt.startsWith(heading)
    ? 0 : staticPrompt.indexOf(`${separator}${heading}`);
  if (start < 0) return '';
  const offset = start === 0 ? heading.length : start + separator.length + heading.length;
  const instructions = staticPrompt.slice(offset);
  const deferredStart = instructions.lastIndexOf(DEFERRED_TOOL_INSTRUCTIONS);
  if (deferredStart < 0) return instructions;
  const suffix = instructions.slice(deferredStart + DEFERRED_TOOL_INSTRUCTIONS.length);
  if (suffix !== '' && !/^\n\nAvailable sources:\n(?:- \*\*[^\n]+\*\*: [^\n]*(?:\n|$))+$/.test(suffix)) {
    return instructions;
  }
  return instructions.slice(0, deferredStart);
}
