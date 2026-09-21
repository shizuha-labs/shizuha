import { describe, it, expect } from 'vitest';
import {
  consumeEnsureAgentAccountDiag,
} from '../../src/daemon/agent-accounts.js';

describe('PLAT-7787 ensureAgentAccount diag', () => {
  it('consume is empty when unused', () => {
    expect(consumeEnsureAgentAccountDiag()).toBeNull();
  });
});
