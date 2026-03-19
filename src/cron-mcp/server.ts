#!/usr/bin/env node
/**
 * Shizuha Cron MCP Server — provides schedule_job, list_jobs, remove_job tools
 * to any MCP-compatible agent (Claude Code, Codex CLI).
 *
 * Runs as a stdio MCP server inside agent containers. When cron jobs fire,
 * POSTs to the bridge's /v1/proactive endpoint for instant delivery.
 *
 * Usage: node cron-mcp-server.js [--workspace /workspace] [--bridge-port PORT]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as http from 'node:http';
import { CronStore, parseSchedule, type CronDelivery } from '../cron/store.js';
import { MemoryStore, MEMORY_TOOLS, handleMemoryTool } from './memory.js';
import { MEDIA_TOOLS, handleMediaTool } from './media-tools.js';
import { SkillSearchEngine, SKILL_TOOLS, handleSkillTool } from './skill-search.js';
import { MemoryIndex } from '../memory/index.js';
import { requestAgentGatewayJson } from '../auth/agent-gateway.js';

// ── Config ──
const workspace = process.argv.includes('--workspace')
  ? process.argv[process.argv.indexOf('--workspace') + 1]!
  : process.env['WORKSPACE'] || '/workspace';

const bridgePort = process.argv.includes('--bridge-port')
  ? parseInt(process.argv[process.argv.indexOf('--bridge-port') + 1]!, 10)
  : parseInt(process.env['BRIDGE_PORT'] || '0', 10);

const agentUsername = process.env['AGENT_USERNAME'] || 'unknown';

const store = new CronStore(workspace);
const memoryStore = new MemoryStore(workspace);
const TICK_MS = 15_000; // Check every 15s

// Memory index (FTS5 + optional vector embeddings)
let memoryIndex: MemoryIndex | null = null;
try {
  const vectorEnabled = !!(process.env['OPENAI_API_KEY'] || process.env['EMBEDDING_API_KEY']);
  memoryIndex = new MemoryIndex(workspace, {
    vectorEnabled,
    embeddingApiKey: process.env['EMBEDDING_API_KEY'] || process.env['OPENAI_API_KEY'] || '',
  });
  memoryIndex.sync().then(stats => {
    if (stats.indexed > 0) {
      process.stderr.write(`[cron-mcp] Memory index: ${stats.indexed} chunks indexed, ${stats.embedded} embedded\n`);
    }
  }).catch(() => {});
} catch {
  process.stderr.write('[cron-mcp] Memory index unavailable (non-fatal)\n');
}

// Skills are in ~/.shizuha/skills/ or /opt/skills/ (mounted from host)
const skillsDirs = [
  path.join(process.env['HOME'] ?? '/root', '.shizuha', 'skills'),
  '/opt/skills',
  path.join(workspace, '.shizuha', 'skills'),
];
const skillsDir = skillsDirs.find(d => fs.existsSync(d)) ?? skillsDirs[0]!;
const skillEngine = new SkillSearchEngine(skillsDir);
skillEngine.load();
process.stderr.write(`[cron-mcp] Loaded ${skillEngine.count} skills from ${skillsDir}\n`);

// Default delivery target — bridge will pick it up from the proactive file
const defaultDelivery: CronDelivery = {
  channelId: 'mcp-cron',
  threadId: 'proactive',
  channelType: 'mcp',
};

// ── MCP Protocol ──
const SERVER_INFO = {
  name: 'shizuha-cron',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'schedule_job',
    description:
      'Schedule a prompt to run at a future time or on a recurring basis. ' +
      'The result will be delivered to the dashboard as a proactive message.\n\n' +
      'Schedule formats:\n' +
      '  - Delay: "30s", "5m", "2h", "1d"\n' +
      '  - Interval: "every 5m", "every 2h"\n' +
      '  - Cron: "0 9 * * *" (5-field)\n\n' +
      'Examples:\n' +
      '  schedule_job(name="Reminder", prompt="Remind user to stretch", schedule="30m")\n' +
      '  schedule_job(name="Status Check", prompt="Check system health", schedule="every 1h")',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short name for this job' },
        prompt: { type: 'string', description: 'The message/prompt to deliver when the job fires' },
        schedule: { type: 'string', description: 'When to run: "30s", "every 5m", or "0 9 * * *"' },
      },
      required: ['name', 'prompt', 'schedule'],
    },
  },
  {
    name: 'list_jobs',
    description: 'List all scheduled cron jobs with their status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_disabled: { type: 'boolean', description: 'Include completed/disabled jobs' },
      },
    },
  },
  {
    name: 'remove_job',
    description: 'Remove a scheduled cron job by its ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_id: { type: 'string', description: 'The job ID to remove (from list_jobs)' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'configure_heartbeat',
    description:
      'Configure a periodic heartbeat — the agent will receive a proactive message at the ' +
      'specified interval prompting it to check on tasks, review status, and act proactively.\n\n' +
      'The heartbeat reads HEARTBEAT.md from the workspace (if it exists) as a checklist.\n\n' +
      'Examples:\n' +
      '  configure_heartbeat(interval="every 30m", enabled=true)\n' +
      '  configure_heartbeat(enabled=false)  -- disable heartbeat',
    inputSchema: {
      type: 'object' as const,
      properties: {
        interval: { type: 'string', description: 'How often: "every 10m", "every 30m", "every 1h"' },
        enabled: { type: 'boolean', description: 'Enable or disable the heartbeat' },
        checklist: { type: 'string', description: 'Optional custom checklist (overrides HEARTBEAT.md)' },
      },
      required: ['enabled'],
    },
  },
  // Memory tools
  ...MEMORY_TOOLS,
  // Media tools (browser, TTS, image gen, canvas, remote exec)
  ...MEDIA_TOOLS,
  // Skill search (deferred knowledge loading)
  ...SKILL_TOOLS,
  // Integration guides
  {
    name: 'integration_guide',
    description:
      'Get usage instructions for third-party integrations.\n' +
      'Available: github, notion, trello, spotify, weather, obsidian, summarize, smarthome, camera\n\n' +
      'Returns API usage examples with curl/CLI commands.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        service: { type: 'string', description: 'Integration name: github, notion, trello, spotify' },
      },
      required: ['service'],
    },
  },
  // Inter-agent communication
  {
    name: 'message_agent',
    description:
      'Send a message to another agent and get their response. ' +
      'Use this to delegate tasks, ask questions, or coordinate with other agents.\n\n' +
      'The target agent will process your message and respond.\n\n' +
      'Examples:\n' +
      '  message_agent(target="claw", message="Tell me a joke")\n' +
      '  message_agent(target="shizuhacodex", message="Run the test suite and report results")',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Target agent username or ID (e.g., "claw", "claude", "shizuhacodex")' },
        message: { type: 'string', description: 'Message to send to the target agent' },
        timeout: { type: 'number', description: 'Max wait time in seconds (default: 60)' },
      },
      required: ['target', 'message'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all available agents that you can communicate with via message_agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  // Interactive replies (buttons, polls)
  {
    name: 'interactive_reply',
    description:
      'Send an interactive response with buttons or a poll. Channels render natively.\n\n' +
      'action="buttons": send clickable buttons\n' +
      'action="poll": create a poll\n\n' +
      'Examples:\n' +
      '  interactive_reply(action="buttons", text="Choose:", buttons=[[{"text":"Yes","callbackData":"yes"},{"text":"No","callbackData":"no"}]])\n' +
      '  interactive_reply(action="poll", question="Favorite?", options=["TS","Python","Rust"])',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['buttons', 'poll'], description: 'Type of interactive element' },
        text: { type: 'string', description: 'Accompanying text (for buttons)' },
        buttons: { type: 'array', description: 'Rows of buttons [{text,callbackData,style?}]' },
        question: { type: 'string', description: 'Poll question' },
        options: { type: 'array', items: { type: 'string' }, description: 'Poll options' },
        max_selections: { type: 'number', description: 'Max poll selections' },
        anonymous: { type: 'boolean', description: 'Anonymous poll' },
      },
      required: ['action'],
    },
  },
  // Audit log query
  {
    name: 'audit_log',
    description:
      'Query the security audit trail. Shows tool invocations with timing and risk flags.\n\n' +
      'Examples:\n' +
      '  audit_log(limit=20)\n' +
      '  audit_log(tool="bash", risk_only=true)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max entries (default: 50)' },
        tool: { type: 'string', description: 'Filter by tool name' },
        risk_only: { type: 'boolean', description: 'Only show entries with risk flags' },
      },
    },
  },
  // Agent control (pause/resume)
  {
    name: 'pause_agent',
    description:
      'Pause another agent — stops inbox processing, keeps container running.\n' +
      'Example: pause_agent(target="kai", reason="maintenance")',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Target agent username or ID' },
        reason: { type: 'string', description: 'Reason for pausing' },
      },
      required: ['target'],
    },
  },
  {
    name: 'resume_agent',
    description:
      'Resume a paused agent.\n' +
      'Example: resume_agent(target="kai")',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Target agent username or ID' },
      },
      required: ['target'],
    },
  },
  // Memory index — deep search with FTS5 + optional vector embeddings
  {
    name: 'memory_index_search',
    description:
      'Deep search across all persistent memory using full-text indexing and optional semantic embeddings.\n' +
      'Searches MEMORY.md, memory/*.md, and session logs. Returns ranked results with file paths and scores.\n' +
      'Use this for broad recall queries when memory_search returns nothing.\n\n' +
      'Examples:\n' +
      '  memory_index_search(query="authentication setup")\n' +
      '  memory_index_search(query="what did we decide about the database")',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query — keywords, concepts, or questions' },
        max_results: { type: 'number', description: 'Max results (default: 6)' },
      },
      required: ['query'],
    },
  },
];

// ── Audit logger (for audit_log tool in MCP context) ──
import { AuditLogger } from '../security/audit.js';
import { validateInteractivePayload } from '../gateway/interactive.js';

const auditLogger = new AuditLogger(workspace);

// ── Tool handlers ──
async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  // Interactive reply (buttons, polls)
  if (name === 'interactive_reply') {
    const action = args.action as string;
    if (action === 'buttons') {
      const payload = validateInteractivePayload({ buttons: args.buttons });
      if (!payload) return 'Error: invalid buttons payload. Each button needs {text, callbackData}.';
      const text = (args.text as string) || 'Please choose:';
      let fallback = text + '\n\nOptions:';
      for (const row of payload.buttons!) {
        for (const btn of row) { fallback += `\n  [${btn.text}]`; }
      }
      return fallback;
    }
    if (action === 'poll') {
      const payload = validateInteractivePayload({ poll: { question: args.question, options: args.options, maxSelections: args.max_selections, anonymous: args.anonymous } });
      if (!payload?.poll) return 'Error: invalid poll. Need question + at least 2 options.';
      let text = `Poll: ${payload.poll.question}`;
      payload.poll.options.forEach((opt, i) => { text += `\n  ${i + 1}. ${opt}`; });
      return text;
    }
    return 'Error: action must be "buttons" or "poll"';
  }

  // Audit log query
  if (name === 'audit_log') {
    const entries = auditLogger.query({
      limit: (args.limit as number) || 50,
      tool: args.tool as string | undefined,
      riskOnly: args.risk_only === true,
    });
    if (entries.length === 0) return 'No audit entries found.';
    return entries.map(e => {
      const risks = e.riskFlags.length > 0 ? ` [${e.riskFlags.join(', ')}]` : '';
      const dur = e.durationMs !== undefined ? ` (${e.durationMs}ms)` : '';
      return `${e.timestamp} ${e.phase.toUpperCase()} ${e.tool}${risks}${dur}\n  ${e.inputSummary.slice(0, 200)}`;
    }).join('\n\n');
  }

  // Agent control (pause/resume) — proxied to daemon
  if (name === 'pause_agent' || name === 'resume_agent') {
    const target = args.target as string;
    const action = name === 'pause_agent' ? 'pause' : 'resume';
    try {
      const response = await requestAgentGatewayJson(
        'POST',
        `/v1/agents/${encodeURIComponent(target)}/${action}`,
        name === 'pause_agent' ? { reason: args.reason || 'via MCP' } : {},
        10000,
      );
      const result = response.data as Record<string, unknown>;
      return result.ok || result.status ? `Agent "${target}" ${action}d.` : `Failed: ${result.error || 'unknown'}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }

  // Memory index (deep search with FTS5 + embeddings)
  if (name === 'memory_index_search' && memoryIndex) {
    const query = args.query as string;
    const maxResults = (args.max_results as number) || 6;
    const results = await memoryIndex.search(query, maxResults);
    if (results.length === 0) return `No indexed memories matching "${query}".`;
    const stats = memoryIndex.stats();
    return results.map((r, i) =>
      `${i + 1}. [${r.source}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n   ${r.snippet.slice(0, 300)}`
    ).join('\n\n') + `\n\n(${stats.chunks} chunks indexed, ${stats.embedded} embedded)`;
  }

  // Memory tools (simple file-based)
  if (name.startsWith('memory_')) {
    return handleMemoryTool(memoryStore, name, args);
  }

  // Media tools (browser, TTS, image gen)
  if (name === 'browser_navigate' || name === 'browser' || name === 'text_to_speech' || name === 'generate_image') {
    return handleMediaTool(name, args, workspace);
  }

  // Skill search (deferred knowledge loading)
  if (name === 'search_skills' || name === 'use_skill') {
    return handleSkillTool(skillEngine, name, args);
  }

  // Integration guides (legacy — prefer search_skills)
  if (name === 'integration_guide') {
    const service = (args.service as string || '').toLowerCase();
    // Integration guides are bundled in the binary
    const guides: Record<string, string> = {
      github: `# GitHub Integration\nUse \`gh\` CLI (pre-installed). Examples:\n- \`gh issue list --repo OWNER/REPO\`\n- \`gh pr list --repo OWNER/REPO\`\n- \`gh pr create --title "Title" --body "Desc"\`\n- \`gh issue create --title "Bug" --body "Details"\`\n- \`gh run list\` (CI status)\n- \`gh api repos/OWNER/REPO\` (raw API)\n\nAuth: GITHUB_TOKEN env var or \`gh auth login --with-token\``,
      notion: `# Notion Integration\nUse Notion API via curl. Set NOTION_API_KEY env var.\n- Search: \`curl -X POST 'https://api.notion.com/v1/search' -H "Authorization: Bearer $NOTION_API_KEY" -H "Notion-Version: 2022-06-28" -d '{"query":"term"}'\`\n- Get page: \`curl 'https://api.notion.com/v1/pages/PAGE_ID' -H "Authorization: Bearer $NOTION_API_KEY" -H "Notion-Version: 2022-06-28"\`\n- Create page: POST to /v1/pages with parent + properties`,
      trello: `# Trello Integration\nUse Trello API via curl. Set TRELLO_API_KEY and TRELLO_TOKEN.\n- List boards: \`curl 'https://api.trello.com/1/members/me/boards?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN'\`\n- Create card: \`curl -X POST 'https://api.trello.com/1/cards?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN' -d 'idList=LIST_ID&name=Title'\``,
      spotify: `# Spotify Integration\nUse Spotify Web API. Set SPOTIFY_ACCESS_TOKEN.\n- Now playing: \`curl 'https://api.spotify.com/v1/me/player/currently-playing' -H "Authorization: Bearer $SPOTIFY_ACCESS_TOKEN"\`\n- Search: \`curl 'https://api.spotify.com/v1/search?q=QUERY&type=track' -H "Authorization: Bearer $SPOTIFY_ACCESS_TOKEN"\`\n- Play: \`curl -X PUT 'https://api.spotify.com/v1/me/player/play' -H "Authorization: ..."\``,
      weather: `# Weather\nUse wttr.in (no API key needed).\n- Current: \`curl -s "wttr.in/London?format=%C+%t+%h+%w"\`\n- Forecast: \`curl -s "wttr.in/London?format=3"\`\n- Full: \`curl -s "wttr.in/London"\`\n- JSON: \`curl -s "wttr.in/London?format=j1"\``,
      obsidian: `# Obsidian Integration\nObsidian vaults are plain Markdown files. Use file tools directly.\n- Find notes: \`find /path/to/vault -name "*.md" | head -20\`\n- Search: \`grep -rl "search term" /path/to/vault/\`\n- Create note: Write a .md file to the vault directory\n- Read note: Read the .md file\n- Link notes: Use [[Note Name]] wikilink syntax in content`,
      summarize: `# URL Summarize\nFetch a URL and summarize its content.\n1. Fetch: \`curl -sL "URL" | head -5000\`\n2. Strip HTML: pipe through \`sed 's/<[^>]*>//g'\`\n3. Or use web_fetch tool if available\n4. Then summarize the text content\n\nFor YouTube: \`yt-dlp --skip-download --write-auto-sub --sub-lang en URL\` (if yt-dlp installed)`,
      smarthome: `# Smart Home (Philips Hue)\nControl Hue lights via the Bridge API. Set HUE_BRIDGE_IP and HUE_USERNAME.\n- Discover: \`curl -s "https://discovery.meethue.com"\`\n- List lights: \`curl -s "http://$HUE_BRIDGE_IP/api/$HUE_USERNAME/lights"\`\n- Turn on: \`curl -X PUT "http://$HUE_BRIDGE_IP/api/$HUE_USERNAME/lights/1/state" -d '{"on":true}'\`\n- Set color: \`curl -X PUT "..." -d '{"on":true,"bri":254,"hue":10000,"sat":254}'\``,
      camera: `# IP Camera Integration\nCapture from IP cameras via HTTP/RTSP.\n- MJPEG snapshot: \`curl -o /tmp/snap.jpg "http://CAMERA_IP/snap.cgi"\`\n- RTSP frame: \`ffmpeg -rtsp_transport tcp -i "rtsp://user:pass@CAMERA_IP:554/stream" -frames:v 1 /tmp/snap.jpg\`\n- Motion detect: Most cameras have an API at /api/motion or /cgi-bin/motion.cgi`,
    };
    if (guides[service]) return guides[service];
    return `Unknown service "${service}". Available: ${Object.keys(guides).join(', ')}`;
  }

  // Inter-agent communication
  if (name === 'message_agent') {
    const target = args.target as string;
    const message = args.message as string;
    const timeout = ((args.timeout as number) || 60) * 1000;

    try {
      const response = await requestAgentGatewayJson(
        'POST',
        `/v1/agents/${encodeURIComponent(target)}/ask`,
        { content: message, from_agent: agentUsername, timeout },
        timeout + 5000,
      );
      const result = response.data as Record<string, unknown>;
      if (result.ok) {
        return `[${result.from}]: ${result.response}`;
      }
      return `Error from ${target}: ${result.error || 'unknown error'}`;
    } catch (err) {
      return `Error contacting agent "${target}": ${(err as Error).message}`;
    }
  }

  if (name === 'list_agents') {
    try {
      const response = await requestAgentGatewayJson('GET', '/v1/agents', undefined, 5000);
      const result = response.data as Record<string, unknown>;
      const agents = (result.agents ?? []) as Array<{ name: string; username: string; id: string; status: string }>;
      return agents.map(a => `- ${a.name} (@${a.username}) — ${a.status}`).join('\n') || 'No agents found';
    } catch {
      return 'Error: cannot reach daemon';
    }
  }
  await store.load();

  switch (name) {
    case 'schedule_job': {
      const { name: jobName, prompt, schedule } = args as { name: string; prompt: string; schedule: string };
      const parsed = parseSchedule(schedule);
      const job = await store.addJob({ name: jobName, prompt, schedule: parsed, deliver: defaultDelivery });
      return JSON.stringify({
        success: true,
        jobId: job.id,
        name: job.name,
        nextRunAt: job.nextRunAt,
        schedule: parsed.display,
        repeats: job.repeat.times === 1 ? 'once' : job.repeat.times === null ? 'forever' : `${job.repeat.times} times`,
      }, null, 2);
    }

    case 'list_jobs': {
      const includeDisabled = args.include_disabled === true;
      const jobs = store.listJobs(includeDisabled);
      if (jobs.length === 0) return 'No scheduled jobs.';
      return JSON.stringify(jobs.map(j => ({
        id: j.id,
        name: j.name,
        schedule: j.schedule.display,
        nextRunAt: j.nextRunAt,
        enabled: j.enabled,
        lastStatus: j.lastStatus ?? 'never run',
        prompt: j.prompt.length > 80 ? j.prompt.slice(0, 77) + '...' : j.prompt,
      })), null, 2);
    }

    case 'remove_job': {
      const removed = await store.removeJob(args.job_id as string);
      return removed ? `Job "${args.job_id}" removed.` : `Job "${args.job_id}" not found.`;
    }

    case 'configure_heartbeat': {
      const enabled = args.enabled as boolean;
      const interval = (args.interval as string) || 'every 30m';

      // Remove existing heartbeat job if any
      const existing = store.listJobs(true).find(j => j.name === '__heartbeat__');
      if (existing) await store.removeJob(existing.id);

      if (!enabled) {
        return JSON.stringify({ success: true, heartbeat: 'disabled' });
      }

      // Read HEARTBEAT.md for checklist items
      let checklist = args.checklist as string || '';
      if (!checklist) {
        const heartbeatPath = path.join(workspace, 'HEARTBEAT.md');
        try {
          if (fs.existsSync(heartbeatPath)) {
            checklist = fs.readFileSync(heartbeatPath, 'utf-8');
          }
        } catch { /* no heartbeat file */ }
      }

      const prompt = checklist
        ? `[Heartbeat] Review your checklist and act on any pending items:\n\n${checklist}`
        : '[Heartbeat] Check in: review any pending tasks, ongoing work, and proactively report status or take action on anything that needs attention.';

      const parsed = parseSchedule(interval);
      const job = await store.addJob({
        name: '__heartbeat__',
        prompt,
        schedule: parsed,
        deliver: defaultDelivery,
      });

      return JSON.stringify({
        success: true,
        heartbeat: 'enabled',
        interval: parsed.display,
        nextRunAt: job.nextRunAt,
        hasChecklist: !!checklist,
      }, null, 2);
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

/** POST to the bridge's /v1/proactive endpoint */
function deliverToBridge(text: string): Promise<boolean> {
  if (!bridgePort) {
    // Fallback: write to file if bridge port not configured
    const filePath = path.join(workspace, '.shizuha-proactive.jsonl');
    fs.appendFileSync(filePath, JSON.stringify({ ts: Date.now(), text, type: 'cron' }) + '\n');
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ text, type: 'cron' });
    const req = http.request({
      hostname: '127.0.0.1',
      port: bridgePort,
      path: '/v1/proactive',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      res.resume(); // drain
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

// ── Cron scheduler (lightweight — no LLM, just delivers the prompt text) ──
async function tick() {
  try {
    await store.load();
    const due = store.getDueJobs();
    for (const job of due) {
      const text = `⏰ ${job.name}\n\n${job.prompt}`;
      const ok = await deliverToBridge(text);
      await store.markJobRun(job.id, ok ? 'ok' : 'error', ok ? undefined : 'delivery failed');
      process.stderr.write(`[cron-mcp] ${ok ? 'Delivered' : 'FAILED'}: ${job.name}\n`);
    }
  } catch (err) {
    process.stderr.write(`[cron-mcp] Tick error: ${(err as Error).message}\n`);
  }
}

// ── MCP stdio protocol ──
function sendResponse(id: string | number, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id: string | number, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

async function handleRequest(req: { id: string | number; method: string; params?: unknown }) {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;

    case 'notifications/initialized':
      // Client acknowledges init — no response needed
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const p = params as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = await handleTool(p.name, p.arguments ?? {});
        sendResponse(id, {
          content: [{ type: 'text', text: result }],
        });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id) sendError(id, -32601, `Method not found: ${method}`);
      break;
  }
}

// ── Main ──
async function main() {
  await store.load();
  process.stderr.write(`[cron-mcp] Started (workspace: ${workspace})\n`);

  // Start cron ticker
  setInterval(tick, TICK_MS);
  const tickTimer = setTimeout(tick, 5000); // First tick after 5s
  tickTimer.unref?.();

  // Read JSON-RPC from stdin
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed);
      if (req.method) {
        await handleRequest(req);
      }
    } catch {
      // Skip malformed input
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[cron-mcp] Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
