import * as path from 'node:path';

/**
 * Wrap file path references (path/file.ext:line:col) with OSC 8 hyperlinks.
 * Terminal emulators that support OSC 8 will render them as clickable links.
 */
export function wrapFileLinks(text: string, cwd: string): string {
  // Match patterns like: path/to/file.ext:line:col or path/to/file.ext:line
  // Requires at least one / in the path or starts with ./ or ../
  // This avoids matching bare words like "file.ts" that might be in prose
  const filePattern = /((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[\w]+)(?::(\d+)(?::(\d+))?)?/g;

  return text.replace(filePattern, (match, filePath: string) => {
    // Skip if this match is part of a URL (check for :// before the match)
    const matchIdx = text.indexOf(match);
    if (matchIdx > 0) {
      const preceding = text.slice(Math.max(0, matchIdx - 8), matchIdx);
      if (/https?:\/\/$/.test(preceding) || preceding.endsWith('://')) return match;
    }
    // Skip if it looks like a version number (e.g., v1.2.3)
    if (/^v?\d+\.\d+\.\d+/.test(filePath)) return match;

    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    // Sanitize: strip any ESC or BEL chars from the URL
    const safeUrl = `file://${absPath.replace(/[\x1b\x07]/g, '')}`;

    return `\x1b]8;;${safeUrl}\x07${match}\x1b]8;;\x07`;
  });
}
