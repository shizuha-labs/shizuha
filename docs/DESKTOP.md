# Shizuha Desktop

Shizuha Desktop is the GUI for the same Code harness as `shizuha` / `shizuha exec`. The model is the DeepSeek Harness / Hermes Desktop one: **a native (or browser) shell around the official local Web GUI, with a supervised local core**.

The headline feature is **Hina-style speech-to-speech**. You talk. The agent talks back. File tools run in the local SCLI process — not in a second Voice stub.

Pulse: **SCLI-603**. Related: SCLI-135 / SCLI-136 (signed Mac/Windows store builds), HLD *SCLI owns Live speech-to-speech*.

## 60-second path (any OS)

```bash
# 1. Install the CLI (Node 22+)
curl -fsSL https://shizuha.com/install.sh | bash

# 2. Auth for Live (pick one)
export XAI_API_KEY=xai-...          # Grok Voice Think Fast
# or:  shizuha login                 # Cortex mints the realtime session

# 3. Open Desktop
shizuha desktop
```

Click **Live**. Grant the microphone. Speak. The HUD should go Connecting → Listening.

Typed chat still uses whatever model you picked (Claude, Codex, grok-4.6, Ollama…). Live overlays `grok-voice-think-fast-2.0` for the call only.

## Native app (Windows / macOS / Linux)

From this repo:

```bash
cd cli
npm install
npm run build
npm run build:tauri
npm run tauri -- build
```

Artifacts:

| OS | Bundle |
|---|---|
| Windows | NSIS installer (`Shizuha_*.exe`) |
| macOS | `.app` / `.dmg` (unsigned until SCLI-135 Apple Developer ID) |
| Linux | AppImage / deb when Tauri targets are enabled |

The Tauri shell starts or attaches `shizuha up` and loads the same dashboard. First-run screen: **Start local core**.

Unsigned preview is expected. SmartScreen / Gatekeeper warnings go away when SCLI-135/136 signing lands. That is not a blocker for trying Live.

## What Live actually does

```
Mic PCM16 @ 24 kHz
  → Desktop / dashboard  WS /v1/voice/realtime?agent=<username>
  → daemon proxy         → agent gateway :localPort
  → GrokVoiceS2SSession  → wss://api.x.ai/v1/realtime
  → ToolRegistry (read/write/edit/bash/glob/grep/web_fetch)
  → speaker
```

Hina on shizuha.com uses the same SCLI session code. Desktop uses the **code** tool floor. CEO Office seats keep the lean Pulse/Wiki floor.

## Requirements

- Node 22+
- A running local core (`shizuha desktop` starts `shizuha up` if needed)
- For Live: `XAI_API_KEY` **or** `shizuha login` (Cortex). A Grok OAuth JWT (`eyJ…`) is rejected — that 403’d Hina Live.
- Microphone permission in the OS / browser

## Not in v0

- Apple notarization / Authenticode (SCLI-135 / SCLI-136)
- TUI-native capture (the terminal is a spectator; Desktop holds the mic)
- Growing Pulse/Wiki stubs inside the Voice service
