# Quick start — Shizuha Code

You do **not** need a Shizuha ID. You need Node.js 22+ and an LLM endpoint.

## 1. Install

Supported source-build machines: linux-x64, linux-arm64, darwin-x64, darwin-arm64.
`./install.sh` downloads Node.js 22 for that architecture when it is not already installed.

```bash
git clone https://github.com/shizuha-labs/shizuha.git
cd shizuha
./install.sh
```

Or from a release binary:

```bash
curl -fsSL https://shizuha.com/install.sh | bash
```

## 2. Point at a model

**Ollama (local, no API key):**

```bash
ollama serve          # if it is not already running
ollama pull llama3.2
shizuha auth endpoint --url http://127.0.0.1:11434/v1 --model llama3.2
```

**vLLM / llama.cpp / any OpenAI-compatible server:**

```bash
shizuha auth endpoint --url http://127.0.0.1:8000/v1 --model YOUR_MODEL_ID
# if the server checks a key:
shizuha auth endpoint --url http://127.0.0.1:8000/v1 --key "$API_KEY" --model YOUR_MODEL_ID
```

**OpenAI / OpenRouter / etc.:**

```bash
export OPENAI_API_KEY=sk-...
# optional: export OPENAI_BASE_URL=https://openrouter.ai/api/v1
shizuha auth openai "$OPENAI_API_KEY" --url "${OPENAI_BASE_URL:-https://api.openai.com/v1}" --model gpt-4.1
```

Check what was saved:

```bash
shizuha auth status
```

## 3. Run

```bash
shizuha exec -p "List the top-level files and say what this repo is." --model openai:llama3.2
shizuha --model openai:llama3.2
```

Use `openai:MODEL` so the request goes to **your** endpoint. A bare name like `Qwen3.6-27B` also uses that endpoint when you have no Cortex login.

**Optional hosted try-out (Shizuha Cortex → OpenCode Zen free models):**

```bash
shizuha login
# or: shizuha auth cortex sk-cortex-...
shizuha --model cortex/big-pickle
```

Same seven free models OpenCode lists at $0 (2026-08-16): `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`, `laguna-s-2.1-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`. You do **not** paste an OpenCode key — Cortex relays. Weekly usage is 80,000 weighted tokens, Monday 00:00 IST. Check remaining with `shizuha usage` or `/usage`. Your own URL still wins and is never billed.

## What you can skip

| Skip | Unless you want |
|------|-----------------|
| `shizuha login` | Hosted Cortex / OpenCode Zen free models |
| `shizuha up` / `shizuha desktop` | The browser / Desktop GUI + Live voice. TUI/`exec` work without it |
| ChatGPT / Claude accounts | You already have a local or OpenAI-compatible URL |

## Troubleshooting

- `Unknown provider` — pass `--model openai:YOUR_ID` after `auth endpoint`.
- Connection refused — the URL must be reachable from this machine; include `/v1` or let `auth endpoint` append it.
- Still hitting `cortex.shizuha.com` — you are logged into Shizuha ID or set `CORTEX_API_KEY`. Use `openai:MODEL` or `cortex/MODEL` explicitly.
