import { describe, it, expect, beforeEach } from 'vitest';
import { getAllStatusItems, getStatusItems, setStatusItems, toggleStatusItem } from '../../src/tui/utils/statusConfig.js';

const COMPACT_DEFAULT = ['model', 'mode', 'verbosity', 'context', 'lines', 'branch'] as const;

describe('statusConfig', () => {
  beforeEach(() => {
    setStatusItems([...COMPACT_DEFAULT]);
  });

  it('defaults to compact status items', () => {
    expect(getStatusItems()).toEqual(COMPACT_DEFAULT);
  });

  it('supports optional noisy items via toggle', () => {
    const shown = toggleStatusItem('tokens');
    expect(shown).toBe(true);
    expect(getStatusItems()).toContain('tokens');
  });

  it('advertises all available status items', () => {
    const all = getAllStatusItems();
    expect(all).toContain('tokens');
    expect(all).toContain('turns');
    expect(all).toContain('time');
    expect(all).toContain('session');
    expect(all).toContain('verbosity');
  });
});
