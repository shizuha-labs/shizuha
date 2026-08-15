# Shizuha Code (public export)

This tree is the **coding-agent harness**: TUI, `exec`/`resume`, `gateway`, and provider bridges.

It is **not** the in-cluster fleet supervisor. That actuator is developed on `shizuha-beta` and dual-homed in `hive-runtime`.
`src/daemon/k8s-backend.ts` here is a no-op stub so local `shizuha up` still typechecks without shipping Hive/k3s internals.
