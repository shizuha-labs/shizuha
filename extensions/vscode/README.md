# Shizuha for VS Code

Shizuha brings the local Shizuha agent core into VS Code. The extension is a thin client: provider calls, authentication, sessions, tools, and file operations remain owned by the installed local core.

## Features

- **Chat:** open **Shizuha: Open Chat** and stream agent responses, tool activity, errors, and cancellation state.
- **Run monitor:** inspect active and recent runs in the **Shizuha Runs** Explorer view and status bar.
- **Provider settings:** configure Cortex, Anthropic, or OpenAI-compatible defaults. Tokens are stored through VS Code SecretStorage; raw secrets are never written to workspace settings or the webview.
- **File review:** inspect proposed text changes in the native VS Code diff editor, then explicitly accept, reject, or partially apply them through the extension host.

## Requirements

1. VS Code 1.92 or newer.
2. The shizuha CLI installed and available on PATH.
3. A local core at http://127.0.0.1:8015 (the extension can start it with shizuha serve).

## Getting started

1. Install the extension.
2. Open a trusted workspace.
3. Run **Shizuha: Retry/Start Local Core**.
4. Run **Shizuha: Configure Provider and Model**.
5. Open **Shizuha: Open Chat**.

The endpoint and expected protocol can be changed under **Settings → Shizuha**.

## Trust and privacy

The webview is UI-only and uses a strict content security policy. Provider secrets stay in VS Code SecretStorage, file edits always require explicit user action, and the extension does not enable prompt or file-content telemetry.

## Support

Report issues at <https://github.com/shizuha-labs/shizuha/issues>.
