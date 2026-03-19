import * as fs from 'node:fs';
import * as path from 'node:path';

/** Extract @file mentions from text and return resolved file paths */
export function extractFileMentions(text: string, cwd: string): string[] {
  const mentions: string[] = [];
  // Match @path patterns (alphanumeric, dots, slashes, hyphens, underscores)
  const regex = /@([\w.\/\-]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1]!;
    const resolved = path.resolve(cwd, filePath);
    try {
      fs.accessSync(resolved, fs.constants.R_OK);
      mentions.push(resolved);
    } catch {
      // Not a valid file path — ignore
    }
  }
  return [...new Set(mentions)];
}

/** Get file suggestions for a partial path */
export function getFileSuggestions(partial: string, cwd: string, limit = 10): string[] {
  const dir = path.dirname(path.resolve(cwd, partial));
  const base = path.basename(partial).toLowerCase();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.name.toLowerCase().startsWith(base))
      .slice(0, limit)
      .map((e) => {
        const rel = path.relative(cwd, path.join(dir, e.name));
        return e.isDirectory() ? rel + '/' : rel;
      });
  } catch {
    return [];
  }
}
