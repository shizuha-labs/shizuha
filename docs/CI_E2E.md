# Shizuha CI and Long E2E

Shizuha has two CI tiers:

- Fast CI runs on every push and pull request. It type-checks, builds the Node bundle, and runs deterministic TUI/provider/tool tests.
- Long E2E runs on a schedule or manually. It assumes Cortex is highly available and exercises the real Shizuha CLI against `cortex/GLM-4.7`.

## Commands

Fast local gate:

```bash
npm run ci:fast
```

`ci:fast` uses a temporary HOME and disables ambient `.mcp.json` loading so local developer configuration cannot affect the push/PR gate.

Long Cortex-backed E2E:

```bash
npm run build:node
npm run test:e2e:long
```

Useful overrides:

```bash
SHIZUHA_LONG_E2E_MODEL=cortex/GLM-4.7 npm run test:e2e:long
CORTEX_BASE_URL=https://cortex.shizuha.com npm run test:e2e:long
```

For private Cortex deployments, set one of:

- `CORTEX_API_KEY`
- `CORTEX_OAUTH_TOKEN`

The long run writes raw stdout, stderr, parsed events, and a summary under `ci-artifacts/e2e/`.

## Current Long E2E Coverage

- CLI bundle starts and exposes `exec`.
- Cortex text-only response works.
- Cortex tool-bearing response uses the streaming path and writes a file.
- Resume preserves session state and can read back prior workspace output.
- MCP stdio discovery works through `ToolSearch`, then calls a deferred MCP tool.
- One easy benchmark-style coding task verifies generated Python with real execution.

The full `benchmark/benchmark.py` harness remains outside the GitHub workflow because it depends on local Docker images, evaluator services, model credentials, and dashboard state. The long E2E suite intentionally reuses small benchmark task shapes through the production Shizuha CLI path instead.
