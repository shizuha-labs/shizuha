// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/web/lib/markdown.js';

describe('renderMarkdown sanitizer', () => {
  it('removes executable markup, event handlers, and unsafe URLs from the production markdown path', () => {
    const rendered = renderMarkdown([
      '<script>globalThis.__markdownXss = true</script>',
      '<img src="x" onerror="globalThis.__markdownXss = true">',
      '<a href="javascript:alert(1)" onclick="alert(2)">unsafe link</a>',
      '<svg><a href="javascript:alert(3)"><text>unsafe svg link</text></a></svg>',
    ].join('\n'));

    expect(rendered).not.toMatch(/<script|onerror|onclick|javascript:/i);
    expect(rendered).toContain('unsafe link');
    expect(rendered).toContain('unsafe svg link');
  });

  it('preserves the safe formatting and URL attributes allowed by the production policy', () => {
    const rendered = renderMarkdown(
      '**bold** and *emphasis* with [safe link](https://example.com/docs)\n\n' +
      '<code>const safe = true;</code>',
    );

    expect(rendered).toContain('<strong>bold</strong>');
    expect(rendered).toContain('<em>emphasis</em>');
    expect(rendered).toContain('href="https://example.com/docs"');
    expect(rendered).toContain('<code>const safe = true;</code>');
  });
});
