import {
  resolveCortexAuthToken,
  resolveCortexBaseUrl,
  CORTEX_OPENCODE_ZEN_FREE_IDS,
} from './registry.js';
import type { ShizuhaConfig } from '../config/types.js';

export interface CortexPlanSnapshot {
  plan: string;
  meter: string;
  policy_version: number;
  allowance_tokens: number;
  consumed_tokens: number;
  reserved_tokens: number;
  remaining_tokens: number;
  period_start: string;
  resets_at: string;
  rpm: number | null;
  max_inflight: number | null;
}

export interface CortexHaneSnapshot {
  currency: string;
  display: string;
  available: number;
  mint: number;
  serve: number;
  mint_remaining_this_week: number;
  weekly_mint_cap: number;
  daily_claimed: boolean;
}

export interface CortexUsageView {
  configured: boolean;
  reason?: 'sign_in';
  error?: string;
  plans: CortexPlanSnapshot[];
  hane?: CortexHaneSnapshot | null;
  freeModels: readonly string[];
}

export const CODE_PLAN_CODE = 'shizuha-code-free-v1';

export function formatCodePlanLine(plan: CortexPlanSnapshot): string {
  const remaining = Number(plan.remaining_tokens || 0).toLocaleString('en-IN');
  const allowance = Number(plan.allowance_tokens || 0).toLocaleString('en-IN');
  const reset = plan.resets_at || 'next Monday 00:00 IST';
  return `${remaining} / ${allowance} weighted tokens remaining · resets ${reset}`;
}

export function selectCodePlan(plans: CortexPlanSnapshot[]): CortexPlanSnapshot | undefined {
  return plans.find((p) => p.plan === CODE_PLAN_CODE) ?? plans[0];
}

export async function fetchCortexUsage(config?: ShizuhaConfig): Promise<CortexUsageView> {
  const token = resolveCortexAuthToken(config);
  if (!token) {
    return {
      configured: false,
      reason: 'sign_in',
      plans: [],
      freeModels: CORTEX_OPENCODE_ZEN_FREE_IDS,
    };
  }
  const base = resolveCortexBaseUrl(config).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/v1/usage?days=7`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        configured: true,
        error: `Cortex /v1/usage ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`,
        plans: [],
        freeModels: CORTEX_OPENCODE_ZEN_FREE_IDS,
      };
    }
    const payload = await res.json() as {
      plans?: CortexPlanSnapshot[];
      hane?: CortexHaneSnapshot | null;
    };
    return {
      configured: true,
      plans: Array.isArray(payload.plans) ? payload.plans : [],
      hane: payload.hane ?? null,
      freeModels: CORTEX_OPENCODE_ZEN_FREE_IDS,
    };
  } catch (err) {
    return {
      configured: true,
      error: (err as Error).message,
      plans: [],
      freeModels: CORTEX_OPENCODE_ZEN_FREE_IDS,
    };
  }
}

export function renderCortexUsage(view: CortexUsageView): string {
  const models = view.freeModels.join(', ');
  if (!view.configured) {
    return [
      'Shizuha Code hosted try-out is off until you sign in.',
      '  shizuha login',
      `Free models (via Cortex → OpenCode Zen): ${models}`,
      'Your own OpenAI-compatible URL stays unbilled.',
    ].join('\n');
  }
  if (view.error) {
    return `Could not load Cortex usage: ${view.error}`;
  }
  const plan = selectCodePlan(view.plans);
  if (!plan) {
    return [
      'Signed in. Weekly Code grant will appear after Cortex provisions it.',
      `Free models: ${models}`,
    ].join('\n');
  }
  const haneLine = view.hane
    ? `Hane: ${Number(view.hane.available || 0).toLocaleString('en-IN')} (${view.hane.daily_claimed ? 'daily claimed' : 'daily ready'} · ${Number(view.hane.mint_remaining_this_week || 0).toLocaleString('en-IN')} faucet left this week)`
    : '';
  return [
    `Shizuha Code Free (${plan.plan}): ${formatCodePlanLine(plan)}`,
    haneLine,
    `Free models: ${models}`,
    plan.remaining_tokens === 0
      ? 'Allowance exhausted. Add prepaid later, spend Hane on marketplace listings, or paste your own endpoint.'
      : '',
  ].filter(Boolean).join('\n');
}
