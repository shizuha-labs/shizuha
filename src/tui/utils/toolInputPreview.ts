const MAX_VALUE_CHARS = 90;
const PRIORITY_KEYS = [
  'pattern',
  'query',
  'file_path',
  'path',
  'cwd',
  'include',
  'exclude',
  'url',
  'command',
];

function keyPriority(key: string): number {
  const idx = PRIORITY_KEYS.indexOf(key);
  return idx === -1 ? PRIORITY_KEYS.length : idx;
}

function truncate(text: string, maxChars = MAX_VALUE_CHARS): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return truncate(value.replace(/\s+/g, ' ').trim());
  }
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

/**
 * Build compact 2-3 line input preview for tool calls.
 */
export function previewToolInput(input: Record<string, unknown>, maxLines = 3): string[] {
  const entries = Object.entries(input);
  if (entries.length === 0) return [];

  const sorted = [...entries].sort(([a], [b]) => keyPriority(a) - keyPriority(b));
  const lines: string[] = [];
  const maxDataLines = Math.max(1, maxLines - 1);

  for (const [key, value] of sorted.slice(0, maxDataLines)) {
    lines.push(`${key}: ${stringifyValue(value)}`);
  }

  const remaining = sorted.length - maxDataLines;
  if (remaining > 0 && lines.length < maxLines) {
    lines.push(`... +${remaining} more`);
  }

  return lines;
}

