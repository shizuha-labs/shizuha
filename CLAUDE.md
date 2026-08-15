# CLAUDE.md — Shizuha Code

Developer notes for working in this repository. Shizuha Code is a local AI
agent runtime (TUI, daemon, dashboard, and `shizuha exec`).

## Commands

```bash
npm run build:check    # tsc --noEmit
npm run build:node     # esbuild → dist/shizuha.js
npm test               # vitest run
npm run ci             # typecheck + build + full suite
```

```bash
node dist/shizuha.js                 # interactive TUI
node dist/shizuha.js exec -p "..."   # one-shot
node dist/shizuha.js up --foreground # daemon + dashboard (:8015)
node dist/shizuha.js doctor          # diagnostics
```

## Layout

```
src/index.ts          CLI entry
src/agent/            agent loop / turns / tools
src/tui/              Ink terminal UI
src/daemon/           local daemon + dashboard
src/provider/         LLM providers
src/tools/            built-in tools
tests/                vitest
```

Do not mount this source tree into agent containers. Ship `dist/shizuha.js`.

## Permissions

- **plan** — read-only
- **supervised** — low-risk auto, else ask
- **autonomous** — all tools allowed

## License

AGPL-3.0-or-later. See LICENSE.
