# CLAUDE.md - Shizuha Agent Runtime

## Workflow

**Always discuss the implementation plan with the user before writing any code.** Present your approach, the files you'll change, and key design decisions. Wait for approval before proceeding. Do not jump straight into coding — alignment first, implementation second.

## Overview

**Shizuha** is an AI agent runtime and orchestration platform. It runs 15 autonomous agents in isolated containers, each with 34 built-in tools, 21 MCP tools, 28 searchable skills, multi-channel messaging (Telegram, Discord, WhatsApp), and a web dashboard.

| Setting | Value |
|---------|-------|
| Dashboard Port | 8015 |
| Language | TypeScript (Node.js) |
| Build | esbuild → dist/shizuha.js |
| Test | vitest |
| Containers | sysbox DinD (15 agents) |

## Modes

| Mode | Command | Description |
|------|---------|-------------|
| **Daemon** | `shizuha up` | Orchestrates all agents, dashboard at :8015 |
| **Gateway** | `shizuha gateway` | Single agent process (used by daemon internally) |
| **TUI** | `shizuha` | Interactive terminal UI |
| **CLI** | `shizuha exec -p "..."` | Single prompt execution |
| **Serve** | `shizuha serve` | HTTP API server (SSE/NDJSON streaming) |

## Commands

```bash
# Build
npm run build                    # esbuild → dist/shizuha.js

# Type check
npm run build:check              # tsc --noEmit

# Tests
npm test                         # vitest run

# Daemon
node dist/shizuha.js up --foreground
node dist/shizuha.js down
node dist/shizuha.js status

# Gateway (single agent)
node dist/shizuha.js gateway --agent-id ID --agent-name NAME --port 8017

# CLI
node dist/shizuha.js exec --prompt "..." --model gpt-5.3-codex
node dist/shizuha.js config
```

## Project Structure

```
shizuha/
├── src/
│   ├── index.ts                 # CLI entry (commander) — all commands
│   ├── server.ts                # HTTP API (Fastify, SSE/NDJSON streaming)
│   │
│   ├── agent/                   # Core agent loop
│   │   ├── loop.ts              # plan → act → observe cycle
│   │   ├── turn.ts              # Single LLM turn + tool execution
│   │   ├── sub-agent.ts         # Sub-agent spawning
│   │   └── types.ts             # AgentConfig, Message, ToolCall
│   │
│   ├── daemon/                  # Agent orchestration daemon
│   │   ├── manager.ts           # Container lifecycle, port allocation, DinD
│   │   ├── dashboard.ts         # Dashboard HTTP + WS server (:8015)
│   │   ├── state.ts             # Persisted daemon state (agents, enabled)
│   │   ├── platform-client.ts   # Platform API client
│   │   └── types.ts             # DaemonConfig, AgentInfo
│   │
│   ├── gateway/                 # Agent process (long-running gateway)
│   │   ├── agent-process.ts     # Core: inbox, session, tool registry, channels
│   │   ├── channels/            # Messaging channel implementations
│   │   │   ├── http.ts          # HTTP/WS channel (device pairing, SSE)
│   │   │   ├── telegram.ts      # Telegram Bot API (long-polling, streaming edits)
│   │   │   ├── discord.ts       # Discord Gateway WS (identify, resume, edits)
│   │   │   ├── whatsapp.ts      # WhatsApp Cloud API (webhook, receipts)
│   │   │   └── shizuha-ws.ts    # Platform relay (Kafka-style delivery)
│   │   ├── broadcast.ts         # Fan-out broadcast manager
│   │   ├── delivery-queue.ts    # Retry queue for message delivery
│   │   ├── auto-reply.ts        # Auto-reply engine
│   │   ├── rate-limiter.ts      # Per-model rate limiting
│   │   ├── usage-tracker.ts     # Token usage tracking
│   │   └── types.ts             # Channel, Inbox, ChannelConfig types
│   │
│   ├── provider/                # LLM providers (10 providers)
│   │   ├── anthropic.ts         # Claude (Anthropic SDK)
│   │   ├── openai.ts            # GPT/o-series (OpenAI SDK)
│   │   ├── codex.ts             # Codex (ChatGPT backend API)
│   │   ├── claude-code.ts       # Claude Code OAuth provider
│   │   ├── google.ts            # Gemini (Google GenAI)
│   │   ├── ollama.ts            # Local models (Ollama HTTP)
│   │   ├── openrouter.ts        # OpenRouter (any model)
│   │   ├── llamacpp.ts          # llama.cpp server
│   │   ├── copilot.ts           # Copilot ACP provider
│   │   └── registry.ts          # Model → provider routing + fallback chains
│   │
│   ├── tools/                   # Tool system (34 built-in tools)
│   │   ├── registry.ts          # Tool registry + JSON Schema gen
│   │   ├── toolsets.ts          # Named toolsets (filter tools per agent)
│   │   ├── builtin/             # Built-in tool implementations
│   │   │   ├── index.ts         # registerBuiltinTools() — 34 tools
│   │   │   ├── read.ts, write.ts, edit.ts, glob.ts, grep.ts, bash.ts
│   │   │   ├── web-fetch.ts, web-search.ts, browser.ts, pdf-extract.ts
│   │   │   ├── cron.ts          # schedule_job, list_jobs, remove_job, heartbeat
│   │   │   ├── memory.ts        # Session memory (add/remove/search)
│   │   │   ├── skill-search.ts  # search_skills, use_skill (BM25)
│   │   │   ├── inter-agent.ts   # message_agent, list_agents
│   │   │   ├── text-to-speech.ts, image-gen.ts
│   │   │   ├── task.ts, task-output.ts, task-stop.ts
│   │   │   └── ... (notebook, todo, plan-mode, session-search, usage, apply-patch)
│   │   └── mcp/                 # MCP client (stdio + HTTP)
│   │
│   ├── cron-mcp/                # MCP server for Claude/Codex bridges (21 tools)
│   │   ├── server.ts            # MCP stdio server
│   │   ├── memory.ts            # Persistent memory (categories, BM25 search)
│   │   └── skill-search.ts      # SkillSearchEngine (BM25, usage boost)
│   │
│   ├── cron/                    # Cron scheduler
│   │   ├── scheduler.ts         # Background job executor (60s tick)
│   │   └── store.ts             # Job persistence (workspace volume)
│   │
│   ├── claude-bridge/           # Claude Code CLI bridge
│   ├── codex-bridge/            # Codex CLI bridge
│   ├── openclaw-bridge/         # OpenClaw gateway bridge
│   │
│   ├── skills/                  # Skill system (SKILL.md loader + registry)
│   ├── devices/                 # Device pairing (code-based auth)
│   ├── permissions/             # 3-mode permission engine
│   ├── config/                  # 4-layer TOML config
│   ├── state/                   # SQLite state + compaction
│   ├── prompt/                  # System prompt builder
│   ├── events/                  # Event emitter + SSE/NDJSON
│   ├── tasks/                   # Background task registry
│   ├── hooks/                   # Lifecycle hooks
│   ├── tui/                     # React/Ink terminal UI
│   ├── web/                     # Dashboard frontend (Vite + React)
│   └── utils/                   # Logger, tokens, fs, diff, git, audio, tts, image
│
├── tests/                       # vitest unit tests
├── dist/                        # Build output (shizuha.js + web/)
├── rt-build/                    # Release build scripts
└── OPENCLAW_PARITY.md           # Feature gap tracker vs OpenClaw
```

## Key Architecture

### Agent Process (gateway mode)
Each agent is a long-running gateway subprocess with:
- **Eternal session** — single brain with continuous memory, compacted as needed
- **Inbox** — messages from all channels processed sequentially (FIFO)
- **34 built-in tools** — file ops, web, cron, memory, skills, inter-agent, media
- **MCP client** — connects to platform services (Pulse, Wiki, Drive, Notes, etc.)
- **5 channel types** — HTTP/WS, Telegram, Discord, WhatsApp, Platform relay
- **Fan-out** — responses broadcast to all channels with fan-out enabled
- **Delivery queue** — retry failed deliveries with exponential backoff
- **Skill search** — BM25-style search over 28 SKILL.md files

### Daemon (up mode)
- Discovers agents from `~/.shizuha/agents.json`
- Spawns each in a sysbox DinD container
- Resolves port allocation, credential injection, skill mounts
- Dashboard at :8015 (agent management, chat, settings)
- HTTPS proxy for container IPv6 workaround

### Container Layout
```
/opt/shizuha/          # Project root (read-only mount)
/opt/skills/           # Skills repo (read-only mount)
/workspace/            # Agent workspace (writable, persistent volume)
/home/agent/.claude/   # Claude Code sessions (persistent)
```

## LLM Providers

| Provider | Models | Config Key |
|----------|--------|------------|
| Codex | gpt-5.3-codex, gpt-5-codex-mini | `shizuha auth codex` (device code, free) |
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | ANTHROPIC_API_KEY |
| OpenAI | gpt-4.1, o3, o4-mini | OPENAI_API_KEY |
| Google | gemini-2.5-pro, gemini-2.5-flash | GOOGLE_API_KEY |
| OpenRouter | any model | OPENROUTER_API_KEY |
| Ollama | any local model | OLLAMA_BASE_URL |
| llama.cpp | GGUF models | LLAMACPP_BASE_URL |

## Messaging Channels

| Channel | Protocol | Key Feature |
|---------|----------|-------------|
| HTTP/WS | Fastify + WS | Device pairing, SSE streaming |
| Telegram | Bot API long-polling | Progressive message editing |
| Discord | Gateway WebSocket | Identify/resume, streaming edits |
| WhatsApp | Cloud API + webhook | Read receipts, typing indicators |
| Shizuha WS | Platform relay | Kafka-style cursor-based delivery |

## Key Patterns

- **Exact string replacement** for file editing (not diffs, not line numbers)
- **Parallel reads, sequential writes** for tool concurrency
- **Zod schemas** for tool parameters (auto-generates JSON Schema for LLM)
- **mcp__\<server\>__\<tool\>** naming for MCP-provided tools
- **Single-pass compaction** when context exceeds threshold
- **NDJSON** for session persistence and streaming
- **State injection** for shared resources (setCronStore, setSkillSearchEngine)
- **fs.realpathSync** on process.argv[1] for container mount path resolution

## Permission Modes

- **plan**: Read-only tools only, no writes
- **supervised**: Low-risk auto-allowed, medium/high require approval
- **autonomous**: Everything auto-allowed

Also reference [../CLAUDE.md](../CLAUDE.md) for platform-wide rules (agent team, testing, Docker).
