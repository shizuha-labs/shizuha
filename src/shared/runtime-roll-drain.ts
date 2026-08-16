const DEFAULT_RUNTIME_ROLL_DRAIN_LEASE_MS = 60_000;
const MIN_RUNTIME_ROLL_DRAIN_LEASE_MS = 5_000;
const MAX_RUNTIME_ROLL_DRAIN_LEASE_MS = 120_000;

export type RuntimeRollDrainState = 'idle' | 'draining' | 'ready';

export interface RuntimeRollDrainRequest {
  requestId: string;
  targetImage: string;
  leaseMs?: unknown;
}

export interface RuntimeRollDrainSnapshot {
  protocol: 1 | 2;
  requestId: string;
  targetImage: string;
  state: Exclude<RuntimeRollDrainState, 'idle'>;
  acceptingTurns: boolean;
  busy: boolean;
  pendingAcceptedTurns: number;
  leaseUntil: number;
  ingressFenced?: boolean;
  admissionVersion?: number;
}

export function isLoopbackRuntimeRollCaller(address: string): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

export function normalizeRuntimeRollDrainLeaseMs(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RUNTIME_ROLL_DRAIN_LEASE_MS;
  return Math.min(
    MAX_RUNTIME_ROLL_DRAIN_LEASE_MS,
    Math.max(MIN_RUNTIME_ROLL_DRAIN_LEASE_MS, Math.trunc(parsed)),
  );
}

/**
 * Bridge-local rollout fence.
 *
 * A request stops autonomous successor turns at the next safe boundary. Work
 * already admitted to the bridge may drain first; once `ready`, ingress stays
 * closed until the controller replaces the pod. The lease is deliberately
 * bounded so a failed controller cannot park a healthy agent indefinitely.
 */
export class RuntimeRollDrainLease {
  private state: RuntimeRollDrainState = 'idle';
  private requestId = '';
  private targetImage = '';
  private leaseUntil = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onLeaseExpired: () => void) {}

  get active(): boolean {
    this.expireIfNeeded();
    return this.state !== 'idle';
  }

  get ready(): boolean {
    this.expireIfNeeded();
    return this.state === 'ready';
  }

  arm(request: RuntimeRollDrainRequest): RuntimeRollDrainSnapshot {
    const requestId = request.requestId.trim();
    const targetImage = request.targetImage.trim();
    if (!requestId || requestId.length > 128) {
      throw new Error('runtime_roll_drain_invalid_request_id');
    }
    if (!targetImage || targetImage.length > 512) {
      throw new Error('runtime_roll_drain_invalid_target_image');
    }

    const sameRequest = this.active
      && this.requestId === requestId
      && this.targetImage === targetImage;
    if (!sameRequest) {
      this.state = 'draining';
      this.requestId = requestId;
      this.targetImage = targetImage;
    }
    this.leaseUntil = Date.now() + normalizeRuntimeRollDrainLeaseMs(request.leaseMs);
    this.armExpiryTimer();
    return this.snapshot(false, 0)!;
  }

  markReady(): void {
    if (!this.active) return;
    this.state = 'ready';
  }

  snapshot(busy: boolean, pendingAcceptedTurns: number): RuntimeRollDrainSnapshot | null {
    if (!this.active) return null;
    return {
      protocol: 1,
      requestId: this.requestId,
      targetImage: this.targetImage,
      state: this.state === 'ready' ? 'ready' : 'draining',
      acceptingTurns: this.state !== 'ready',
      busy,
      pendingAcceptedTurns: Math.max(0, Math.trunc(pendingAcceptedTurns)),
      leaseUntil: this.leaseUntil,
    };
  }

  dispose(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.state = 'idle';
  }

  private armExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (Date.now() < this.leaseUntil) {
        this.armExpiryTimer();
        return;
      }
      this.expire();
    }, Math.max(1, this.leaseUntil - Date.now()));
    this.expiryTimer.unref?.();
  }

  private expireIfNeeded(): void {
    if (this.state !== 'idle' && Date.now() >= this.leaseUntil) this.expire();
  }

  private expire(): void {
    if (this.state === 'idle') return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.state = 'idle';
    this.requestId = '';
    this.targetImage = '';
    this.leaseUntil = 0;
    this.onLeaseExpired();
  }
}
