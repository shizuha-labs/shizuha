import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

const MAX_PARSE_LENGTH = 140_000;

// Simple LRU cache for rendered markdown
const cache = new Map<string, string>();
const CACHE_MAX = 200;

export function renderMarkdown(text: string): string {
  if (!text) return '';

  const cached = cache.get(text);
  if (cached) return cached;

  let html: string;
  if (text.length > MAX_PARSE_LENGTH) {
    // Too long — escape and return as preformatted
    html = `<pre>${escapeHtml(text)}</pre>`;
  } else {
    html = marked.parse(text, { async: false }) as string;
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
  cache.set(text, clean);

  return clean;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
