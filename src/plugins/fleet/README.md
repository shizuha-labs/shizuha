# Fleet plugin (internal)

This directory is the **Hive/k3s fleet actuator**. It is how Shizuha
runs named agents as cluster pods.

It is **not** part of the default coding harness. External users get
the TUI **and** the browser dashboard (`src/web` + `src/daemon/dashboard.ts`)
without this plugin. Keep `src/daemon` in the public tree — the dashboard
server lives there. Only this plugin is swapped for a stub.

| Build | What loads |
|---|---|
| Internal (`npm run build:node`) | `k8s-backend.ts` — real kubectl/Hive actuator |
| Public (`npm run build:public`) | `k8s-backend.stub.ts` — no-op (`isK8sAgent` is always false) plus `dist/web` |

Callers keep importing `src/daemon/k8s-backend.ts`. That file only
re-exports the plugin.
