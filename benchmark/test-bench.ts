// Simulate what shizuha-claude does in the benchmark
import { buildSystemPrompt, DYNAMIC_BOUNDARY_MARKER } from '../src/prompt/builder.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin/index.js';
import Anthropic from '@anthropic-ai/sdk';

const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
if (!token) { console.log("No token"); process.exit(1); }

const client = new Anthropic({
  apiKey: null as any,
  authToken: token,
  maxRetries: 0,
  timeout: 60000,
  dangerouslyAllowBrowser: true,
  defaultHeaders: { 'x-app': 'cli', 'User-Agent': 'claude-code/2.1.29' },
});

async function main() {
  // Build tools and system prompt exactly like exec mode
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  toolRegistry.unregister('task');
  const toolDefs = toolRegistry.definitions();

  const tools = toolDefs.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));

  // Apply tool-level global cache
  for (let i = tools.length - 1; i >= 0; i--) {
    if (!tools[i]!.name.startsWith('mcp__')) {
      (tools[i] as any).cache_control = { type: 'ephemeral', ttl: '1h' }; // no scope:global — causes API 500
      break;
    }
  }

  const systemText = await buildSystemPrompt({
    cwd: '/tmp',
    tools: toolDefs,
    provider: 'claude-code',
  });

  // Split system prompt on marker
  const markerIdx = systemText.indexOf(DYNAMIC_BOUNDARY_MARKER);
  const system: any[] = [];
  if (markerIdx >= 0) {
    const staticPart = systemText.slice(0, markerIdx).replace(/\n*---\n*$/, '').trim();
    const dynamicPart = systemText.slice(markerIdx + DYNAMIC_BOUNDARY_MARKER.length).replace(/^\n*---\n*/, '').trim();
    if (staticPart) system.push({ type: 'text', text: staticPart, cache_control: { type: 'ephemeral', ttl: '1h' } });
    if (dynamicPart) system.push({ type: 'text', text: dynamicPart, cache_control: { type: 'ephemeral', ttl: '1h' } });
  } else {
    system.push({ type: 'text', text: systemText, cache_control: { type: 'ephemeral', ttl: '1h' } });
  }

  // Count cache blocks
  const sysCacheCount = system.filter((s: any) => s.cache_control).length;
  const toolCacheCount = 1; // from the global cache on last tool
  const totalCacheBlocks = sysCacheCount + toolCacheCount;
  console.log(`System cache blocks: ${sysCacheCount}, Tool cache: ${toolCacheCount}, Total: ${totalCacheBlocks}`);
  console.log(`System blocks:`, system.map((s: any) => ({ text: s.text.substring(0, 50), cache: s.cache_control })));
  console.log(`Tools count: ${tools.length}`);

  // Test streaming with beta API
  const prompt = "Say hello in 3 words";
  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 32000,
      messages: [{ role: 'user', content: prompt }],
      system,
      tools,
      stream: true,
      betas: ['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'prompt-caching-scope-2026-01-05'],
      thinking: { type: 'enabled', budget_tokens: 31999 },
    });
    let eventCount = 0;
    let stopReason = '';
    for await (const event of response as any) {
      eventCount++;
      if (event.type === 'message_delta') {
        stopReason = event.delta?.stop_reason || '';
        console.log(`✅ Works! stop: ${stopReason}, usage:`, JSON.stringify(event.usage));
      }
    }
    console.log(`Total events: ${eventCount}`);
  } catch (e: any) {
    console.log(`❌ FAILED: ${e.status} ${e.message?.substring(0, 500)}`);
  }
}

main().catch(console.error);
