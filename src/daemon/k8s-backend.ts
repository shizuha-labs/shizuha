/**
 * Fleet k8s actuator entry.
 *
 * Internal builds load `src/plugins/fleet/k8s-backend.ts` (our Hive/k3s
 * control plane). Public / `--no-fleet-plugin` builds swap that module for
 * `k8s-backend.stub.ts` so external users get TUI + dashboard without the
 * cluster actuator.
 *
 * Callers keep importing `./k8s-backend.js`.
 */
export * from '../plugins/fleet/k8s-backend.js';
