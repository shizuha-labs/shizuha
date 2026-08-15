# Benchmarking

The Python benchboard / campaign suite now lives in Origin `shizuha-labs/cortex`
at `benchboard/`. Live UI: `https://cortex.shizuha.com/benchboard`.

This repo keeps the coding-agent harness (`shizuha` TUI / `exec` / `gateway`).
Cortex campaigns still invoke the reviewed `shizuha-agent-runtime` image via
`shizuha exec`.

Prefix-fingerprint helpers used by harness tests are in
`src/telemetry/bench-prefix-debug.ts`.
