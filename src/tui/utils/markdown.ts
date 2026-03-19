import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// ANSI escape codes for inline formatting
const BOLD_ON = '\x1b[1m';
const BOLD_OFF = '\x1b[22m';
const ITALIC_ON = '\x1b[3m';
const ITALIC_OFF = '\x1b[23m';
const CODE_ON = '\x1b[36m';  // cyan for inline code
const CODE_OFF = '\x1b[39m';

/**
 * Fix inline formatting that marked-terminal misses inside list items.
 * marked-terminal v7.x doesn't render **bold**, *italic*, or `code`
 * inside list items — the raw markers pass through unchanged.
 */
function fixInlineFormatting(text: string): string {
  return text
    // **bold** (not inside ANSI sequences)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD_ON}$1${BOLD_OFF}`)
    // *italic* (single *, not list bullets which are at line start)
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `${ITALIC_ON}$1${ITALIC_OFF}`)
    // `code` (backticks not already inside ANSI)
    .replace(/`([^`\n]+)`/g, `${CODE_ON}$1${CODE_OFF}`);
}

/** Render markdown text to ANSI-styled terminal output */
export function renderMarkdown(text: string, width = 80): string {
  const marked = new Marked();
  marked.use(
    markedTerminal({
      width,
      tab: 2,
      code: true,
      reflowText: true,
      showSectionPrefix: false,
    }) as ReturnType<typeof markedTerminal>,
  );
  let result = marked.parse(text, { async: false }) as string;
  // Strip trailing newlines that marked adds
  result = result.replace(/\n+$/, '');
  // Fix bold/italic/code inside list items (marked-terminal v7.x bug)
  result = fixInlineFormatting(result);
  return result;
}
