# Shizuha Code (public export)

This tree is the **coding-agent harness**. You get both flavours:

- **Terminal** — `shizuha` TUI, plus `exec` / `resume` / `gateway` / provider bridges
- **Browser** — `shizuha up` starts the local daemon and the same dashboard we use internally (`src/web` + `src/daemon/dashboard.ts` on :8015)

Keep `src/daemon`. The dashboard server lives there. What is **not** included is the in-cluster Hive/k3s fleet actuator. That is an internal plugin on `shizuha-beta` (`src/plugins/fleet`) and is dual-homed in `hive-runtime`. Public / `--no-fleet-plugin` builds load a no-op stub.
