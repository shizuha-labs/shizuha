import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

/** Current agent username — set by the chat UI when switching agents.
 * Used to rewrite workspace image paths to the file-serving API endpoint. */
let currentAgentUsername = '';

const MAX_PARSE_LENGTH = 140_000;

// Simple LRU cache for rendered markdown
const cache = new Map<string, string>();
const CACHE_MAX = 200;

/** Set the current agent context for image path rewriting. */
export function setMarkdownAgentContext(username: string): void {
  currentAgentUsername = username;
}

export function renderMarkdown(text: string): string {
  if (!text) return '';

  // Cache key includes agent context (different agents → different image URLs)
  const cacheKey = currentAgentUsername ? `${currentAgentUsername}:${text}` : text;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Rewrite workspace image paths before parsing.
  // Agents reference images as: ![alt](/workspace/path/to/image.png)
  // Rewrite to: ![alt](/v1/workspace/{username}/files/path/to/image.png)
  let processedText = text;
  if (currentAgentUsername) {
    // Markdown image syntax: ![alt](/workspace/...) or ![alt](workspace/...)
    processedText = processedText.replace(
      /!\[([^\]]*)\]\((\/workspace\/|workspace\/)([^)]+)\)/g,
      (_, alt, _prefix, filePath) => `![${alt}](/v1/workspace/${currentAgentUsername}/files/${filePath})`,
    );
    // Also handle plain file references like /workspace/screenshots/foo.png in text.
    // The lookbehind excludes `(`, `/`, and word chars to avoid matching inside
    // already-rewritten URLs like /v1/workspace/... (the `1` before `/workspace/`
    // is a word char, so (?<![(/\w]) correctly rejects it).
    processedText = processedText.replace(
      /(?<![(/\w])\/workspace\/([^\s)]+\.(?:png|jpg|jpeg|gif|webp|svg))/gi,
      (_, filePath) => `![image](/v1/workspace/${currentAgentUsername}/files/${filePath})`,
    );
  }

  let html: string;
  if (processedText.length > MAX_PARSE_LENGTH) {
    // Too long — escape and return as preformatted
    html = `<pre>${escapeHtml(processedText)}</pre>`;
  } else {
    html = marked.parse(processedText, { async: false }) as string;
  }

  // Sanitize
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4',
      'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'sub',
      'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul', 'del',
      // Canvas/visual support — SVG + basic layout
      'div', 'svg', 'rect', 'circle', 'line', 'polyline', 'polygon', 'path',
      'text', 'tspan', 'g', 'defs', 'use', 'symbol', 'clipPath',
      'linearGradient', 'radialGradient', 'stop', 'pattern',
      'foreignObject', 'marker', 'title', 'desc',
      // Chart/diagram elements
      'figure', 'figcaption', 'details', 'summary', 'mark',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'class', 'target', 'rel',
      // SVG attributes
      'viewBox', 'xmlns', 'width', 'height', 'x', 'y', 'cx', 'cy', 'r',
      'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'd', 'fill', 'stroke',
      'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
      'transform', 'text-anchor', 'font-size', 'font-family', 'font-weight',
      'opacity', 'style', 'points', 'offset', 'stop-color', 'stop-opacity',
      'gradientUnits', 'patternUnits', 'markerWidth', 'markerHeight',
      'refX', 'refY', 'orient', 'id', 'clip-path', 'dominant-baseline',
    ],
    ADD_ATTR: ['target'],
    // Allow SVG namespace
    ADD_URI_SAFE_ATTR: ['xmlns'],
  });

  // Evict oldest if cache is full
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(cacheKey, clean);

  return clean;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
