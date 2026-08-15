import type {
  DaemonLinkRuntimeLaneContext,
  DaemonLinkRuntimeLaneHealth,
} from './daemon-link-client.js';
import type { K8sRuntimeLaneProbe } from './k8s-backend.js';
import { expectedBridgeForExecutionMethod } from './runtime-lane-methods.js';

function value(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function actualBridge(runtime: Record<string, unknown>): string {
  if (runtime.bridge) return String(runtime.bridge);
  if (runtime.service === 'shizuha' && runtime.mode === 'gateway') return 'shizuha-gateway';
  return '';
}

export function runtimeLaneHealthFromProbe(
  context: DaemonLinkRuntimeLaneContext,
  probe: K8sRuntimeLaneProbe,
  workloadReady: boolean,
  containerReady: boolean,
): DaemonLinkRuntimeLaneHealth {
  const lane = context.runtimeLane;
  const primary = lane.primary && typeof lane.primary === 'object' && !Array.isArray(lane.primary)
    ? lane.primary as Record<string, unknown>
    : {};
  const model = String(lane.model ?? primary.model_id ?? '');
  const method = String(lane.execution_method ?? '');
  const runtimeModel = String(probe.runtime.model ?? '');
  const checks: Array<[boolean, string]> = [
    [probe.generation === context.desiredGeneration && probe.digest === context.runtimeLaneDigest, 'runtime_lane_fence_mismatch'],
    [probe.brokerReady, 'credential_broker_not_ready'],
    [actualBridge(probe.runtime) === expectedBridgeForExecutionMethod(method), 'runtime_harness_mismatch'],
    [Boolean(model) && runtimeModel === model, 'runtime_model_mismatch'],
    [value(probe.runtime, 'initialized', 'serverReady') === true, 'runtime_harness_not_initialized'],
    [value(probe.runtime, 'authenticated', 'hasAuth') === true, 'runtime_harness_not_authenticated'],
    [value(probe.runtime, 'providerHealthy', 'provider_available', 'providerAvailable') === true, 'runtime_provider_unavailable'],
    [value(probe.runtime, 'quota_ok', 'quotaOk') === true, 'runtime_provider_quota_unavailable'],
    [value(probe.runtime, 'in_backoff', 'inBackoff') === false, 'runtime_provider_in_backoff'],
    [String(probe.runtime.status ?? '').toLowerCase() === 'ok', 'runtime_health_degraded'],
  ];
  const failed = checks.find(([ok]) => !ok)?.[1];
  const harnessReady = !failed;
  const providerAvailable = value(
    probe.runtime, 'providerHealthy', 'provider_available', 'providerAvailable',
  ) === true;
  const quotaOk = value(probe.runtime, 'quota_ok', 'quotaOk') === true;
  const inBackoff = value(probe.runtime, 'in_backoff', 'inBackoff') === true;
  return {
    apply_status: workloadReady && containerReady && harnessReady ? 'ok' : 'failed',
    workload_ready: workloadReady,
    container_ready: containerReady,
    harness_ready: harnessReady,
    provider_health: {
      available: providerAvailable,
      quota_ok: quotaOk,
      in_backoff: inBackoff,
    },
    ...(failed ? { error: failed } : {}),
  };
}
