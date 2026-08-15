import React, { useMemo } from 'react';
import { Text } from 'ink';
import { renderMarkdown } from '../utils/markdown.js';
import { wrapFileLinks } from '../utils/osc8.js';

interface MarkdownTextProps {
  children: string;
  streaming?: boolean;
  width?: number;
  cwd?: string;
}

/**
 * Renders markdown content as ANSI-styled text.
 * Optionally wraps file paths with OSC 8 clickable links.
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({ children, streaming, width, cwd }) => {
  const rendered = useMemo(() => {
    if (!children) return children;
    try {
      let result = renderMarkdown(children, width ?? process.stdout.columns ?? 80);
      if (cwd) {
        result = wrapFileLinks(result, cwd);
      }
      return result;
    } catch {
      return children;
    }
  }, [children, streaming, width, cwd]);

  return <Text>{rendered}</Text>;
};
