/**
 * CanvasApp — renders agent-generated interactive HTML/JS/CSS in a sandboxed iframe.
 *
 * When the agent uses `canvas_render` with `format: "app"` (or HTML containing
 * <script> tags), the content is rendered in a sandboxed iframe using `srcdoc`.
 * This allows interactive dashboards, charts with JS, forms, mini-apps, etc.
 *
 * Security:
 * - Sandbox restricts: no top navigation, no popups, no same-origin access
 * - Allows: scripts, forms, modals (for interactive content)
 * - Communication: postMessage between iframe and parent for events
 */

import { useState, useRef, useCallback, useEffect } from 'react';

interface CanvasAppProps {
  /** Raw HTML/JS/CSS content to render */
  content: string;
  /** Optional title displayed above the app */
  title?: string;
}

/** Wrap raw HTML in a full document with dark theme defaults and messaging bridge. */
function wrapContent(html: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #18181b;
    color: #e4e4e7;
    font-size: 14px;
    line-height: 1.5;
    overflow: auto;
  }
  button {
    cursor: pointer;
    background: #3f3f46;
    color: #e4e4e7;
    border: 1px solid #52525b;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    transition: background 0.15s;
  }
  button:hover { background: #52525b; }
  input, select, textarea {
    background: #27272a;
    color: #e4e4e7;
    border: 1px solid #3f3f46;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: #7c3aed; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 10px; border: 1px solid #3f3f46; text-align: left; }
  th { background: #27272a; font-weight: 600; }
  a { color: #818cf8; }
  code { background: #27272a; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
  pre { background: #27272a; padding: 10px; border-radius: 6px; overflow-x: auto; }
</style>
</head>
<body>
${html}
<script>
// Bridge: app can send events to the parent dashboard
window.shizuha = {
  send(type, data) {
    window.parent.postMessage({ source: 'canvas-app', type, data }, '*');
  }
};
</script>
</body>
</html>`;
}

/** Determine the ideal iframe height from content (heuristic). */
function estimateHeight(content: string): number {
  const lines = content.split('\n').length;
  const hasTable = /<table/i.test(content);
  const hasCanvas = /<canvas/i.test(content);
  const hasChart = /chart|graph|plot/i.test(content);

  if (hasCanvas || hasChart) return 400;
  if (hasTable) return Math.min(600, 120 + lines * 8);
  return Math.min(500, Math.max(200, 80 + lines * 6));
}

export function CanvasApp({ content, title }: CanvasAppProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(() => estimateHeight(content));

  const srcdoc = wrapContent(content);

  // Listen for postMessage events from the iframe
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.source !== 'canvas-app') return;
      // Future: route events (e.g., form submissions, button clicks) to the agent
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Auto-resize iframe based on content height
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    function onLoad() {
      try {
        const doc = iframe!.contentDocument;
        if (doc?.body) {
          const h = doc.body.scrollHeight + 24;
          setIframeHeight(Math.min(800, Math.max(150, h)));
        }
      } catch {
        // Cross-origin — use estimate
      }
    }

    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [srcdoc]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  // Fullscreen overlay
  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-zinc-950/95 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-shizuha-400">Canvas App</span>
            {title && <span className="text-xs text-zinc-400">{title}</span>}
          </div>
          <button
            onClick={toggleFullscreen}
            className="text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer p-1"
            title="Exit fullscreen"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Iframe — full height */}
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          className="flex-1 w-full border-0 bg-zinc-900"
          title={title || 'Interactive canvas app'}
        />
      </div>
    );
  }

  // Inline card
  return (
    <div className="my-2 rounded-xl border border-zinc-700 overflow-hidden bg-zinc-900">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/60 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-shizuha-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" strokeLinecap="round" />
          </svg>
          <span className="text-xs font-medium text-zinc-300">
            {title || 'Interactive App'}
          </span>
        </div>
        <button
          onClick={toggleFullscreen}
          className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer p-0.5"
          title="Open fullscreen"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
          </svg>
        </button>
      </div>

      {/* Sandboxed iframe */}
      <iframe
        ref={iframeRef}
        srcDoc={srcdoc}
        sandbox="allow-scripts allow-forms allow-modals"
        className="w-full border-0 bg-zinc-900"
        style={{ height: `${iframeHeight}px` }}
        title={title || 'Interactive canvas app'}
      />
    </div>
  );
}

/**
 * Detect whether content is an interactive app (has <script> tags or format="app").
 * Used by MessageBubble to decide between static markdown and CanvasApp rendering.
 */
export function isInteractiveContent(content: string): boolean {
  if (!content) return false;
  // Must contain HTML structure with script tags
  return /<script[\s>]/i.test(content) && /<\/script>/i.test(content);
}

/**
 * Extract the canvas app title from content if it starts with a markdown bold title.
 * Pattern: **Title**\n\n<html content...>
 */
export function extractCanvasTitle(content: string): { title?: string; html: string } {
  const match = content.match(/^\*\*(.+?)\*\*\s*\n\n?([\s\S]+)$/);
  if (match) {
    return { title: match[1], html: match[2]! };
  }
  return { html: content };
}
