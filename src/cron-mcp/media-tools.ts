/**
 * Media tools for MCP — browser automation, TTS, image generation.
 * These augment Claude/Codex with capabilities they lack natively.
 * Uses exec-based approach: calls CLI tools available in the container.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MEDIA_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'canvas_render',
    description:
      'Create visual content (charts, diagrams, UI mockups, interactive apps) that renders inline in the dashboard chat.\n' +
      'Return SVG, HTML, Mermaid markup, or interactive HTML+JS apps.\n\n' +
      'Formats:\n' +
      '  "svg" — static SVG graphics\n' +
      '  "html" — static HTML content\n' +
      '  "app" — interactive HTML/JS/CSS app rendered in a sandboxed iframe (supports <script> tags, buttons, forms, charts)\n' +
      '  "mermaid" — Mermaid diagram markup\n' +
      '  "auto" — auto-detect (default)\n\n' +
      'Examples:\n' +
      '  canvas_render(content="<svg width=\\"200\\" height=\\"100\\"><circle cx=\\"50\\" cy=\\"50\\" r=\\"40\\" fill=\\"blue\\"/></svg>", format="svg")\n' +
      "  canvas_render(content=\"<h1>Counter</h1><button onclick=\\\"n++;document.getElementById('c').textContent=n\\\">+1</button><span id='c'>0</span><script>let n=0</script>\", format=\"app\")",
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'SVG, HTML, Mermaid, or interactive HTML+JS content to render' },
        format: { type: 'string', description: 'Format: "svg", "html", "app", or "mermaid" (default: auto-detect)' },
        title: { type: 'string', description: 'Optional title for the visual' },
      },
      required: ['content'],
    },
  },
  {
    name: 'remote_exec',
    description:
      'Execute a command on a remote host via SSH.\n' +
      'Requires SSH key access configured (e.g., via GITHUB_TOKEN or SSH keys in container).\n\n' +
      'Examples:\n' +
      '  remote_exec(host="user@server.com", command="uptime")\n' +
      '  remote_exec(host="pi@192.168.1.100", command="sensors")',
    inputSchema: {
      type: 'object' as const,
      properties: {
        host: { type: 'string', description: 'SSH target: user@hostname' },
        command: { type: 'string', description: 'Command to execute remotely' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['host', 'command'],
    },
  },
  {
    name: 'browser_navigate',
    description:
      'Navigate a headless browser to a URL and return the page content/screenshot.\n' +
      'Useful for reading web pages, checking dashboards, or scraping data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        action: { type: 'string', description: '"text" for page text, "screenshot" for image, "html" for raw HTML' },
        selector: { type: 'string', description: 'Optional CSS selector to extract specific content' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser',
    description:
      'Full CDP browser automation (Chromium via Playwright). Persistent session across calls.\n' +
      'Actions: navigate, screenshot, click, type, scroll, get_text, evaluate, back, close.\n\n' +
      'Examples:\n' +
      '  browser(action="navigate", url="https://example.com")\n' +
      '  browser(action="screenshot")\n' +
      '  browser(action="click", selector="button.submit")\n' +
      '  browser(action="type", selector="#search", text="hello")\n' +
      '  browser(action="get_text", selector=".results")\n' +
      '  browser(action="evaluate", script="document.title")',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', description: 'navigate|screenshot|click|type|scroll|get_text|evaluate|back|close' },
        url: { type: 'string', description: 'URL for navigate action' },
        selector: { type: 'string', description: 'CSS selector for click/type/get_text' },
        text: { type: 'string', description: 'Text for type action' },
        direction: { type: 'string', description: 'up|down for scroll action' },
        script: { type: 'string', description: 'JavaScript for evaluate action' },
      },
      required: ['action'],
    },
  },
  {
    name: 'text_to_speech',
    description:
      'Convert text to speech audio. Returns the path to the generated audio file.\n' +
      'Useful for voice notifications, accessibility, or audio content creation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to speak' },
        voice: { type: 'string', description: 'Voice name (default: "default")' },
        output_path: { type: 'string', description: 'Output file path (default: /tmp/tts-output.mp3)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate an image from a text description using AI.\n' +
      'Returns the path to the generated image file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Image description/prompt' },
        output_path: { type: 'string', description: 'Output file path (default: /tmp/generated-image.png)' },
        size: { type: 'string', description: 'Image size: "256x256", "512x512", "1024x1024"' },
      },
      required: ['prompt'],
    },
  },
];

export async function handleMediaTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): Promise<string> {
  switch (name) {
    case 'canvas_render': {
      const content = args.content as string;
      const format = (args.format as string) || 'auto';
      const title = args.title as string | undefined;

      // Auto-detect format
      let detectedFormat = format;
      if (format === 'auto') {
        if (content.includes('<svg')) detectedFormat = 'svg';
        else if (/<script[\s>]/i.test(content)) detectedFormat = 'app';
        else if (content.includes('<')) detectedFormat = 'html';
        else detectedFormat = 'text';
      }

      const titleLine = title ? `**${title}**\n\n` : '';

      // Interactive app — return raw HTML with <script> tags intact.
      // The dashboard CanvasApp component detects <script> tags and renders
      // the content in a sandboxed iframe instead of static markdown.
      if (detectedFormat === 'app') {
        return `${titleLine}${content}`;
      }

      // Static SVG/HTML — rendered inline by the markdown renderer
      if (detectedFormat === 'svg' || detectedFormat === 'html') {
        return `${titleLine}${content}`;
      }
      // For other formats, wrap in code block
      return `${titleLine}\`\`\`${detectedFormat}\n${content}\n\`\`\``;
    }

    case 'remote_exec': {
      const host = args.host as string;
      const command = args.command as string;
      const timeout = ((args.timeout as number) || 30) * 1000;

      try {
        const result = execSync(
          `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${JSON.stringify(host)} ${JSON.stringify(command)}`,
          { encoding: 'utf-8', timeout, maxBuffer: 512 * 1024 },
        );
        return result || '(empty output)';
      } catch (err) {
        return `SSH error: ${(err as Error).message}`;
      }
    }

    case 'browser_navigate': {
      const url = args.url as string;
      const action = (args.action as string) || 'text';
      const selector = args.selector as string | undefined;

      // Use curl for simple text/html extraction (always available)
      // For screenshots, would need puppeteer (heavy dependency)
      try {
        if (action === 'html' || action === 'text') {
          const result = execSync(
            `curl -sL --max-time 15 ${JSON.stringify(url)}`,
            { encoding: 'utf-8', timeout: 20000, maxBuffer: 1024 * 1024 },
          );

          if (action === 'text') {
            // Strip HTML tags for plain text
            const text = result
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            const truncated = text.length > 5000 ? text.slice(0, 5000) + '...[truncated]' : text;
            return truncated;
          }
          return result.length > 10000 ? result.slice(0, 10000) + '...[truncated]' : result;
        }

        if (action === 'screenshot') {
          return 'Screenshot requires a browser runtime (Puppeteer/Playwright). Use "text" or "html" action for headless environments, or use the browser tool if available.';
        }

        return `Unknown action: ${action}. Use "text", "html", or "screenshot".`;
      } catch (err) {
        return `Browser error: ${(err as Error).message}`;
      }
    }

    case 'browser': {
      // Full CDP browser via Playwright — persistent session
      const browserAction = args.action as string;
      try {
        const { browserManager } = await import('../browser/manager.js');
        const session = browserManager.getSession('mcp-browser');

        switch (browserAction) {
          case 'navigate': {
            if (!args.url) return 'url is required for navigate';
            return await session.navigate(args.url as string);
          }
          case 'screenshot': {
            const base64 = await session.screenshot();
            return `Screenshot captured (${Math.round(base64.length / 1024)}KB base64). Use canvas_render to display or save to file.`;
          }
          case 'click': {
            if (!args.selector) return 'selector is required for click';
            return await session.click(args.selector as string);
          }
          case 'type': {
            if (!args.selector || !args.text) return 'selector and text are required for type';
            return await session.type(args.selector as string, args.text as string);
          }
          case 'scroll':
            return await session.scroll((args.direction as 'up' | 'down') || 'down');
          case 'get_text':
            return await session.getText(args.selector as string | undefined) || '(no text)';
          case 'evaluate': {
            if (!args.script) return 'script is required for evaluate';
            return await session.evaluate(args.script as string) ?? '(no return)';
          }
          case 'back':
            return await session.back();
          case 'close':
            return await session.close();
          default:
            return `Unknown action: ${browserAction}. Use: navigate, screenshot, click, type, scroll, get_text, evaluate, back, close`;
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("Executable doesn't exist") || msg.includes('browserType.launch')) {
          return `Playwright not available: ${msg}\nFalling back to browser_navigate (curl-based). Install Chromium with: npx playwright install chromium`;
        }
        return `Browser error: ${msg}`;
      }
    }

    case 'text_to_speech': {
      const text = args.text as string;
      const outputPath = (args.output_path as string) || path.join(workspace, 'tts-output.wav');

      // Try espeak (usually available on Linux), fall back to festival, then to a message
      try {
        // Check if espeak is available
        try {
          execSync('which espeak-ng || which espeak', { encoding: 'utf-8', timeout: 3000 });
          const safeText = text.replace(/'/g, "'\\''");
          execSync(`espeak-ng '${safeText}' -w ${JSON.stringify(outputPath)} 2>/dev/null || espeak '${safeText}' -w ${JSON.stringify(outputPath)}`, {
            timeout: 10000,
          });
          return JSON.stringify({ success: true, path: outputPath, engine: 'espeak' });
        } catch {
          // No TTS engine available — report it
          return JSON.stringify({
            success: false,
            error: 'No TTS engine available in container. Install espeak-ng: apt-get install espeak-ng',
            text: text.slice(0, 100),
          });
        }
      } catch (err) {
        return `TTS error: ${(err as Error).message}`;
      }
    }

    case 'generate_image': {
      const prompt = args.prompt as string;
      const outputPath = (args.output_path as string) || path.join(workspace, 'generated-image.png');

      // Image generation requires an API call (OpenAI DALL-E, etc.)
      // For now, generate a placeholder SVG
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#1a1a2e"/>
  <text x="256" y="240" text-anchor="middle" fill="#e94560" font-family="sans-serif" font-size="24">🎨 Image Generation</text>
  <text x="256" y="280" text-anchor="middle" fill="#999" font-family="sans-serif" font-size="14">${prompt.slice(0, 50)}</text>
  <text x="256" y="320" text-anchor="middle" fill="#666" font-family="sans-serif" font-size="12">Requires OPENAI_API_KEY for DALL-E</text>
</svg>`;
      const svgPath = outputPath.replace(/\.png$/, '.svg');
      fs.writeFileSync(svgPath, svg);

      return JSON.stringify({
        success: true,
        path: svgPath,
        note: 'Generated placeholder SVG. For real image generation, configure OPENAI_API_KEY and the image gen provider.',
        prompt: prompt.slice(0, 100),
      });
    }

    default:
      return `Unknown media tool: ${name}`;
  }
}
