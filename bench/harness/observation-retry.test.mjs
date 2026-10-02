import { describe, expect, it } from 'vitest';
import { isObservationRetryable, isRetryableMiss } from './observation-retry.mjs';

/**
 * Playwright MCP initialize and browser_click time out on CI. The cell is recorded NOT MEASURED,
 * coverage shrinks, the catch-rate stays 1.0, and the gate goes red. Those timeouts are the machine,
 * not the scenario — retry once. A missing tool is still a miss.
 */

describe('isObservationRetryable', () => {
  it('retries an initialize handshake that never answered', () => {
    expect(isObservationRetryable(new Error('timeout after 60000ms on initialize'))).toBe(true);
  });

  it('retries a Playwright click that hung', () => {
    expect(
      isObservationRetryable(
        new Error('tool browser_click failed: ### Error\nTimeoutError: browserBackend.callTool:'),
      ),
    ).toBe(true);
  });

  it('retries a cell the harness itself abandoned', () => {
    expect(isObservationRetryable(new Error('cell exceeded 240000ms and was abandoned'))).toBe(
      true,
    );
  });

  // The same hung call, worded without "TimeoutError" — how network-timeout/playwright was lost
  // twice while broken-form-validation/playwright was retried.
  it('retries a backend call that failed without naming a timeout', () => {
    expect(
      isObservationRetryable(
        new Error('tool browser_click failed: ### Error\nError: browserBackend.callTool: Error: '),
      ),
    ).toBe(true);
  });

  // Deterministic and the scenario's fault: the selector matched more than one element. Retrying it
  // turns a defect the grid should report into a slow NOT MEASURED.
  it('does not retry a strict-mode violation — that is the scenario, not the machine', () => {
    expect(
      isObservationRetryable(
        new Error(
          'tool browser_click failed: ### Error\nError: browserBackend.callTool: Error: strict mode violation',
        ),
      ),
    ).toBe(false);
  });

  it('does not retry a missing tool — that is a real miss', () => {
    expect(isObservationRetryable(new Error('Tool browser_click not found'))).toBe(false);
  });
});

/**
 * A MISS is retried once too, and for the same reason the timeouts are.
 *
 * The incident: a merge-queue run failed `RCR floor: reticle RCR=0.9 (must be 1.0)`. The PR
 * run 40 minutes earlier, on identical content -- the branch contained main's tip with zero
 * divergent commits -- scored 1.0, and the re-run after it scored 1.0 again. One expected_detect
 * cell flipped to NO ISSUE FOUND and back, with the same 49/54 cells measured and zero false
 * positives, while efficiency fell 10.76 -> 9.63. That efficiency drop is the tell: the same work,
 * more tokens per catch, on a runner executing 35 jobs where the PR ran 29.
 *
 * `isObservationRetryable` did not engage because the cell never THREW. It completed, observed
 * nothing, and returned a verdict -- indistinguishable, in the recorded data, from Reticle genuinely
 * failing to catch the bug. A cell carries `detected`, `correct`, `tokens`, `latency_ms` and
 * `verdict`; nothing says "this run was degraded".
 *
 * So the floor stays at 1.0. Lowering it would let a real regression through, and the claim the
 * benchmark exists to defend is that Reticle catches what it says it catches. What changes is that
 * a miss has to REPRODUCE before it is believed -- exactly the rule already applied to timeouts, and
 * one a genuine regression passes every time, because a real miss misses twice.
 *
 * Applied to EVERY tool, not to reticle. Retrying only our own misses would quietly inflate our
 * catch-rate against the competitor column in the same table, which is the one thing a benchmark
 * may never do.
 */
describe('isRetryableMiss', () => {
  it('retries a scenario that should have been detected and was not', () => {
    expect(isRetryableMiss({ expectDetect: true }, false)).toBe(true);
  });

  it('does not retry a scenario that was detected', () => {
    expect(isRetryableMiss({ expectDetect: true }, true)).toBe(false);
  });

  it('does not retry a clean scenario that correctly found nothing', () => {
    // The no-regression control. "Found nothing" is the RIGHT answer here, and retrying it would
    // burn a browser run to re-confirm a pass.
    expect(isRetryableMiss({ expectDetect: false }, false)).toBe(false);
  });

  it('does not retry a clean scenario that reported something', () => {
    // A false positive is a real finding and must not be given a second chance to disappear.
    expect(isRetryableMiss({ expectDetect: false }, true)).toBe(false);
  });

  it('applies to every tool, so a competitor miss gets the same second chance', () => {
    // Not parameterised by tool ON PURPOSE -- see the header. If this ever grows a tool argument,
    // that is the moment the benchmark stops being fair.
    expect(isRetryableMiss.length).toBe(2);
  });
});
