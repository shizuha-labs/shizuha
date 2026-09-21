import { describe, expect, it } from 'vitest';
import {
  CODE_PLAN_CODE,
  formatCodePlanLine,
  renderCortexUsage,
  selectCodePlan,
  type CortexUsageView,
} from '../../src/provider/cortex-usage.js';

const codePlan = {
  plan: CODE_PLAN_CODE,
  meter: 'inference.weighted_tokens',
  policy_version: 1,
  allowance_tokens: 80_000,
  consumed_tokens: 12_000,
  reserved_tokens: 0,
  remaining_tokens: 68_000,
  period_start: '2026-08-10T18:30:00+00:00',
  resets_at: '2026-08-17T18:30:00+00:00',
  rpm: 20,
  max_inflight: 1,
};

describe('cortex usage view (SCLI-597)', () => {
  it('formats remaining and reset from the weekly Code grant', () => {
    expect(selectCodePlan([codePlan])?.plan).toBe(CODE_PLAN_CODE);
    expect(formatCodePlanLine(codePlan)).toContain('68,000 / 80,000');
    expect(formatCodePlanLine(codePlan)).toContain('2026-08-17T18:30:00+00:00');
  });

  it('tells signed-out users to login and keep BYO unbilled', () => {
    const view: CortexUsageView = {
      configured: false,
      reason: 'sign_in',
      plans: [],
      freeModels: ['big-pickle'],
    };
    const text = renderCortexUsage(view);
    expect(text).toContain('shizuha login');
    expect(text).toContain('big-pickle');
    expect(text).toContain('unbilled');
  });

  it('shows exhaustion copy at remaining 0', () => {
    const text = renderCortexUsage({
      configured: true,
      plans: [{ ...codePlan, remaining_tokens: 0, consumed_tokens: 80_000 }],
      freeModels: ['big-pickle'],
    });
    expect(text).toContain('Allowance exhausted');
    expect(text).toContain('own endpoint');
  });

  it('renders the Hane purse when Cortex returns it', () => {
    const text = renderCortexUsage({
      configured: true,
      plans: [codePlan],
      hane: {
        currency: 'HANE',
        display: 'Hane',
        available: 2480,
        mint: 2480,
        serve: 0,
        mint_remaining_this_week: 720,
        weekly_mint_cap: 800,
        daily_claimed: true,
      },
      freeModels: ['big-pickle'],
    });
    expect(text).toContain('Hane: 2,480');
    expect(text).toContain('daily claimed');
    expect(text).not.toMatch(/\bCredits\b/);
  });
});
