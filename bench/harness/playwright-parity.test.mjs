import { describe, expect, it } from 'vitest';
import { parityVerdict } from './playwright-parity.mjs';

/**
 * The claim this product is sold on is that Reticle catches more than Playwright and costs less to
 * do it. Nothing in the repo defends it.
 *
 * Every existing gated dimension compares us against OURSELVES — catch-rate, efficiency, replay
 * tokens, all against the last row. Those catch a regression. None of them would notice the day
 * Playwright's numbers move, or the day ours drift past theirs, because neither is measured against
 * the other. The most quotable claim we make is the one with no test behind it.
 *
 * Both halves are gated, and they are not symmetric. Detection falling below Playwright's is a
 * failure with no honest excuse — it is the whole thesis. Costing more than Playwright is a
 * POSITIONING CHANGE, which may sometimes be the right trade for context that earns it, so it can be
 * declared. It cannot be drifted into silently.
 */

const at = (tokens, accuracy) => ({ avg_tokens_o200k: tokens, detection_accuracy: accuracy });

describe('parityVerdict', () => {
  it('passes when Reticle is cheaper and catches more', () => {
    expect(parityVerdict({ reticle: at(1106, 1), playwright: at(1209, 0.909) }).ok).toBe(true);
  });

  it('passes when Reticle catches the same and costs the same', () => {
    expect(parityVerdict({ reticle: at(1000, 0.9), playwright: at(1000, 0.9) }).ok).toBe(true);
  });

  /**
   * The half with no excuse. If Reticle catches less than the tool it claims to beat, the product's
   * central sentence is false and no amount of token saving redeems it.
   */
  it('FAILS when Reticle catches less, however cheap it got', () => {
    const v = parityVerdict({ reticle: at(10, 0.8), playwright: at(1209, 0.909) });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('catches less');
  });

  it('fails on a detection drop even with a declared token budget', () => {
    // A budget buys tokens. It does not buy the thesis.
    const v = parityVerdict({
      reticle: at(1106, 0.8),
      playwright: at(1209, 0.909),
      declaredCostlier: 'intent capture',
    });
    expect(v.ok).toBe(false);
  });

  it('fails when Reticle costs more and nobody said it would', () => {
    const v = parityVerdict({ reticle: at(1400, 1), playwright: at(1209, 0.909) });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('costs more');
  });

  /**
   * The deliberate case: context that earns its bytes. Allowed, but only when somebody wrote down
   * that they meant it — a positioning change should be a decision, not a drift.
   */
  it('passes a costlier run when it is declared, and echoes the stated reason', () => {
    const v = parityVerdict({
      reticle: at(1400, 1),
      playwright: at(1209, 0.909),
      declaredCostlier: 'intent + gap context, measured worth it',
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toContain('intent + gap context');
  });

  it('tolerates run-to-run noise rather than firing on a rounding difference', () => {
    expect(parityVerdict({ reticle: at(1215, 1), playwright: at(1209, 0.909) }).ok).toBe(true);
  });

  /**
   * Absent evidence is not evidence of parity. A pass here would be the worst possible failure —
   * a green that means "we did not measure".
   */
  it('does not pass when either side was not measured', () => {
    const missing = parityVerdict({ reticle: at(null, null), playwright: at(1209, 0.909) });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('not measured');
    expect(parityVerdict({ reticle: at(1106, 1), playwright: at(null, null) }).ok).toBe(false);
    expect(parityVerdict({}).ok).toBe(false);
  });
});
