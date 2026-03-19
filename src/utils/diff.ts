import { createTwoFilesPatch } from 'diff';

/** Create a unified diff between old and new file contents */
export function createUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  return createTwoFilesPatch(filePath, filePath, oldContent, newContent, '', '', { context: 3 });
}

/** Exact string replacement — core edit operation (like Claude Code's Edit tool). */
export function applyEdit(
  fileContent: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { result: string; replacements: number } {
  if (oldString === newString) {
    throw new Error('old_string and new_string must be different');
  }

  if (!fileContent.includes(oldString)) {
    // Try to find a close match for a better error message
    const lines = oldString.split('\n');
    const firstLine = lines[0]?.trim();
    if (firstLine && fileContent.includes(firstLine)) {
      throw new Error(
        `old_string not found as exact match, but first line "${firstLine}" exists. Check whitespace/indentation.`,
      );
    }
    throw new Error('old_string not found in file');
  }

  if (replaceAll) {
    const parts = fileContent.split(oldString);
    return {
      result: parts.join(newString),
      replacements: parts.length - 1,
    };
  }

  // Ensure uniqueness for single replacement
  const firstIdx = fileContent.indexOf(oldString);
  const secondIdx = fileContent.indexOf(oldString, firstIdx + 1);
  if (secondIdx !== -1) {
    throw new Error(
      'old_string matches multiple locations. Provide more context to make it unique, or use replaceAll.',
    );
  }

  return {
    result: fileContent.slice(0, firstIdx) + newString + fileContent.slice(firstIdx + oldString.length),
    replacements: 1,
  };
}
