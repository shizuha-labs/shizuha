import { useState, useEffect } from 'react';
import { getFileSuggestions } from '../utils/fileMentions.js';

interface UseFileMentionResult {
  suggestions: string[];
  mentionActive: boolean;
  mentionPartial: string;
}

/**
 * Detects @file mentions in input and provides fuzzy-matched file suggestions.
 * Triggers when user types @ followed by a partial path.
 */
export function useFileMention(input: string, cwd: string): UseFileMentionResult {
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // Find the last @mention in the input
  const atIndex = input.lastIndexOf('@');
  const mentionActive = atIndex >= 0 && !input.slice(atIndex).includes(' ');
  const mentionPartial = mentionActive ? input.slice(atIndex + 1) : '';

  useEffect(() => {
    if (!mentionActive || !mentionPartial) {
      setSuggestions([]);
      return;
    }
    const results = getFileSuggestions(mentionPartial, cwd);
    setSuggestions(results);
  }, [mentionActive, mentionPartial, cwd]);

  return { suggestions, mentionActive, mentionPartial };
}
