import { describe, expect, it } from 'vitest';
import { TOKEN_TOL, declaredBudgetOf, tokenVerdict } from './token-budget.mjs';

/**
 * A rise in tokens is either something we chose or something we did not notice, and the gate cannot
 * tell those apart on its own.
 *
 * Reticle is adding context deliberately — intent, gaps, observability — and each of those costs
 * bytes on purpose. Absorbing that by loosening the tolerance would remove the only thing that
 * catches the OTHER kind, and the other kind is real: read-only calls are about half the tool
 * surface, and the two largest payloads we emit are both reads. That is slack, not intent.
 *
 * So a deliberate rise must be DECLARED, not absorbed. The repo already does this in prose — the
 * 2.9.0 row documents a +16% rise, names the feature that caused it, and verifies it against the
 * pre-merge build. This makes that a field the gate reads instead of a paragraph it cannot.
 */

const row = (tokens, budget) => ({
  cost: { replay_mean_tokens: tokens, ...(budget === undefined ? {} : { token_budget: budget }) },
});

describe('declaredBudgetOf', () => {
  it('is zero when a row declares no budget — the honest default', () => {
    expect(declaredBudgetOf(row(278))).toBe(0);
  });

  it('reads a declared budget', () => {
    expect(declaredBudgetOf(row(278, { extra_tokens: 40, reason: 'intent ledger' }))).toBe(40);
  });

  it('is zero for a malformed or missing row rather than an excuse', () => {
    // A budget that cannot be read must never read as "unlimited" — that would turn a corrupt file
    // into a permanently open gate.
    expect(declaredBudgetOf(null)).toBe(0);
    expect(declaredBudgetOf({})).toBe(0);
    expect(declaredBudgetOf(row(278, { reason: 'no number' }))).toBe(0);
    expect(declaredBudgetOf(row(278, { extra_tokens: -50, reason: 'negative' }))).toBe(0);
  });
});

describe('tokenVerdict', () => {
  it('passes when tokens did not move', () => {
    expect(tokenVerdict({ now: 278, last: 278, budget: 0 }).ok).toBe(true);
  });

  it('passes a rise inside the noise tolerance', () => {
    expect(tokenVerdict({ now: 285, last: 278, budget: 0 }).ok).toBe(true);
  });

  it('fails an undeclared rise past the tolerance', () => {
    const v = tokenVerdict({ now: 320, last: 278, budget: 0 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('undeclared');
  });

  /**
   * The point of the whole mechanism: a rise somebody chose, and said so, is not a regression.
   */
  it('passes a rise that fits inside a declared budget', () => {
    expect(tokenVerdict({ now: 320, last: 278, budget: 50 }).ok).toBe(true);
  });

  it('fails a rise that OVERRUNS its declared budget, and says by how much', () => {
    const v = tokenVerdict({ now: 400, last: 278, budget: 50 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('400');
    expect(v.reason).toContain('50');
  });

  /**
   * A budget is spent, not standing. Declaring +50 once must not license +50 on every release after
   * it, or the ceiling ratchets forever and the gate quietly stops meaning anything.
   */
  it('measures the budget against the LAST row, so it cannot be reused release after release', () => {
    // Release A declared +50 and landed at 328. Release B declares nothing and stays at 328: fine.
    expect(tokenVerdict({ now: 328, last: 328, budget: 0 }).ok).toBe(true);
    // Release B tries to spend A's budget again.
    expect(tokenVerdict({ now: 378, last: 328, budget: 0 }).ok).toBe(false);
  });

  it('always passes when there is no baseline to compare against', () => {
    expect(tokenVerdict({ now: 278, last: null, budget: 0 }).ok).toBe(true);
    expect(tokenVerdict({ now: 278, last: undefined, budget: 0 }).ok).toBe(true);
  });

  it('always passes when this run measured nothing', () => {
    expect(tokenVerdict({ now: null, last: 278, budget: 0 }).ok).toBe(true);
  });

  it('never fails a DROP, however large', () => {
    expect(tokenVerdict({ now: 100, last: 278, budget: 0 }).ok).toBe(true);
  });

  it('states the tolerance it used, so the number is checkable', () => {
    expect(TOKEN_TOL).toBe(0.05);
    expect(tokenVerdict({ now: 320, last: 278, budget: 0 }).reason).toContain('5%');
  });
});
