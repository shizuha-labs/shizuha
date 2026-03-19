# Shizuha — AI Agent Runtime

<p align="center">
  <strong>Run autonomous AI coding agents on your own machine.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 22+"></a>
</p>

**Shizuha** is an AI agent runtime and orchestration platform. It runs multiple autonomous agents with built-in tools, multi-channel messaging, and a web dashboard — all on your own hardware.

Each agent has its own identity, model, and execution method. Chat with them from the dashboard, Telegram, Discord, WhatsApp, or any connected channel.

## Features

- **Multi-provider** — Claude (Anthropic), GPT/Codex (OpenAI), Gemini (Google), Ollama, llama.cpp, OpenRouter, and more
- **34 built-in tools** — File ops, search, bash, web fetch, cron, memory, inter-agent messaging, TTS, image gen
- **Web dashboard** — Real-time chat, agent management, settings, model switching (:8015 HTTPS + :8016 HTTP)
- **Multi-agent** — Run multiple agents simultaneously with different models and configurations
- **Plugin system** — Extend with custom tools, channels, hooks, services, and LLM providers
- **Multi-channel** — HTTP/WebSocket, Telegram, Discord, WhatsApp, Slack, Signal, LINE, iMessage
- **TUI** — Interactive terminal interface with streaming, tool display, and session management
- **Auto-HTTPS** — Self-signed TLS certificate generated on first run (reliable WebSocket on all browsers)

## Install

Runtime: **Node.js 22+**.

### From source (developers)

```bash
git clone https://github.com/shizuha-labs/shizuha.git
cd shizuha
./install.sh
```

### From binary (end users)

```bash
curl -fsSL https://shizuha.com/install.sh | bash
```

The installer auto-detects whether you're in a source tree or downloading a prebuilt binary.

### After installation

```bash
# Start the daemon + dashboard
shizuha up

# Dashboard: https://localhost:8015
# Login: shizuha / shizuha (change in Settings)
```

## Default Agents

Shizuha ships with three pre-configured agents, ready out of the box:

| Agent | Model | Method | Description |
|-------|-------|--------|-------------|
| **Claude** | `claude-opus-4-6` | Claude Code bridge | Anthropic Claude with extended thinking (max effort) |
| **Shizuha** | `gpt-5.4-xhigh` | Shizuha runtime | OpenAI via Codex — free with any ChatGPT account |
| **Codex** | `gpt-5.4-xhigh` | Codex app server | OpenAI Codex CLI bridge |

Agents are enabled and configured from the dashboard. You can add, remove, or reconfigure agents at any time.

## Authentication

Each agent needs credentials for its LLM provider. The dashboard guides you through setup:

| Provider | Setup |
|----------|-------|
| **Claude** | Run `claude setup-token` on your machine, paste the token in the dashboard auth card |
| **Codex / Shizuha** | Sign in with your ChatGPT account (device code flow, shown automatically) |
| **Anthropic API** | Set `ANTHROPIC_API_KEY` in environment or dashboard Settings |
| **OpenAI API** | Set `OPENAI_API_KEY` in environment or dashboard Settings |
| **Google** | Set `GOOGLE_API_KEY` for Gemini models |
| **Ollama** | Runs locally — no API key needed |

## Architecture

```
shizuha up
  │
  ├── Dashboard (:8015 HTTPS, :8016 HTTP)
  │     ├── Web UI (React + Tailwind)
  │     ├── WebSocket chat bridge
  │     └── Event log (cursor-based replay for reliability)
  │
  ├── Agent: Claude (:8018, claude-bridge)
  │     └── Claude Code CLI — persistent session, extended thinking
  │
  ├── Agent: Shizuha (:8017, gateway)
  │     ├── 34 built-in tools
  │     ├── MCP client (external tool servers)
  │     ├── Cron scheduler
  │     ├── Skill search (28 searchable skills)
  │     └── Plugin loader
  │
  └── Agent: Codex (:8019, codex-bridge)
        └── Codex CLI — persistent session, xhigh reasoning
```

## Commands

| Command | Description |
|---------|-------------|
| `shizuha` | Interactive TUI |
| `shizuha up` | Start daemon + dashboard |
| `shizuha down` | Stop daemon |
| `shizuha status` | Show daemon and agent status |
| `shizuha exec -p "..."` | Single prompt execution |
| `shizuha serve` | HTTP API server (SSE/NDJSON streaming) |
| `shizuha auth codex` | Authenticate Codex (free with ChatGPT) |
| `shizuha config` | Show current configuration |
| `shizuha doctor` | Health check and diagnostics |

## Configuration

Configuration is layered (highest priority first):

1. **Per-agent**: `~/.shizuha/agents/{username}/agent.toml`
2. **Global**: `~/.shizuha/config.toml`
3. **Environment variables**
4. **Defaults**

Dashboard Settings provides a UI for common configuration (model, credentials, agent settings).

## Plugins

Extend Shizuha with custom tools, channels, hooks, services, and LLM providers.

```
~/.shizuha/plugins/my-plugin/
├── plugin.json     # { "id": "my-plugin", "name": "My Plugin" }
└── index.js        # exports { register(api) { ... } }
```

The `PluginApi` provides:

```javascript
api.registerTool(toolHandler)              // Agent-callable tool
api.registerChannel(channel)               // Messaging channel
api.registerHook(event, command, opts)     // Lifecycle hook
api.registerService(service)               // Background service
api.registerProvider(name, provider)       // LLM provider
```

Plugins are loaded from `~/.shizuha/plugins/` on startup. See [`src/plugins/types.ts`](src/plugins/types.ts) for the full API.

## Messaging Channels

| Channel | Protocol | Setup |
|---------|----------|-------|
| HTTP/WebSocket | Dashboard built-in | Automatic |
| Telegram | Bot API + long-polling | `TELEGRAM_BOT_TOKEN` |
| Discord | Gateway WebSocket | `DISCORD_BOT_TOKEN` |
| WhatsApp | Cloud API + webhooks | Meta Business credentials |
| Slack | Socket Mode | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` |
| Signal | signal-cli REST API | Self-hosted signal-cli container |
| LINE | Messaging API | Channel access token |
| iMessage | BlueBubbles | Self-hosted BlueBubbles server |

Fan-out: when an agent responds on one channel, the response is broadcast to all connected channels with fan-out enabled.

## Development

```bash
# Install dependencies
npm install

# Build (esbuild + vite)
npm run build

# Type check
npm run build:check

# Run tests
npm test

# Dev mode (TUI, no build needed)
npx tsx src/index.ts

# Dev mode (dashboard)
npx tsx src/index.ts up --foreground
```

## Project Structure

```
src/
├── agent/          # Core agent loop (plan → act → observe)
├── daemon/         # Agent orchestration, dashboard server
├── gateway/        # Agent process (inbox, channels, tools)
├── provider/       # LLM providers (Anthropic, OpenAI, Google, Ollama, ...)
├── tools/          # 34 built-in tools + MCP client
├── plugins/        # Plugin loader and SDK types
├── cron/           # Cron scheduler
├── tui/            # Terminal UI (React/Ink)
├── web/            # Dashboard frontend (React + Vite)
├── claude-bridge/  # Claude Code CLI bridge
├── codex-bridge/   # Codex CLI bridge
└── skills/         # Skill system (SKILL.md loader)
```

## Security

- Agents run in isolated Docker containers (sysbox DinD) or bare-metal processes
- Dashboard uses session-based auth with password hashing
- Auto-generated self-signed TLS for HTTPS
- Plugin allowlist controls which plugins are loaded
- No telemetry, no phone-home — everything runs locally

## Contributing

Contributions are welcome. Please open an issue first to discuss significant changes.

```bash
# Before submitting
npm run build:check   # Type check
npm test              # Run tests
```

## License

[AGPL-3.0-or-later](LICENSE) — Copyright (c) 2025 Shizuha Trading LLP

If you modify Shizuha and deploy it as a network service, you must make your modified source code available to users under the same license.
