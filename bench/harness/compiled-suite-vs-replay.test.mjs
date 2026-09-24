import { describe, expect, it } from 'vitest';
import { finding } from './compiled-suite-vs-replay.mjs';
import { SUITE_FLOWS, suiteSteps } from './suite-flows.mjs';

/**
 * The finding is DERIVED, and the flow list has one owner.
 *
 * #1074: the comparison asked replay for `suite-console`, a flow no harness has ever recorded.
 * Replay can only be handed flows that were saved, so it scored at most 3/4 by construction while
 * the Playwright arm — which runs its own inline steps and needs no saved flow — scored 4/4. The
 * artifact then read as a defeat that was really a typo, and nothing re-ran the harness because it
 * was in neither bench pass.
 *
 * The narrative had the same shape of problem: `finding` was a paragraph written in advance,
 * asserting among other things that "on wall-time the compiled script is faster end-to-end". That
 * sentence shipped whatever the run measured. A benchmark that states its answer before running is
 * not evidence, and this repo has already paid for one report that could not be wrong.
 */
describe('the compiled-suite comparison', () => {
  const pw = { passed: 4, end_to_end_ms: 1000, llm_tokens: 0 };
  const rt = { passed: 4, end_to_end_ms: 5000, verify_call_ms: 400, llm_tokens: 0 };

  it('asks only for flows the recorder actually saves', () => {
    const saved = new Set(SUITE_FLOWS.map((f) => f.name));
    expect(suiteSteps().filter((f) => !saved.has(f.name))).toEqual([]);
  });

  it('flattens each flow to the view and control a compiled script would drive', () => {
    const shape = suiteSteps().find((f) => 'suite-shape' === f.name);
    expect(shape).toEqual({ name: 'suite-shape', view: 'diagnostics', tap: 'fault-wrong-data' });
  });

  it('names whichever side was actually faster, not whichever was faster once', () => {
    expect(finding(pw, rt, 4)).toContain('the compiled script was faster');
    expect(finding({ ...pw, end_to_end_ms: 9000 }, rt, 4)).toContain('replay was faster');
  });

  it('reports the verdicts the run produced', () => {
    expect(finding(pw, { ...rt, passed: 3 }, 4)).toContain('playwright 4/4, replay 3/4');
  });

  /* The premise of the whole comparison. If it ever fails, the harness is measuring something else. */
  it('says so loudly when the zero-token premise does not hold', () => {
    const text = finding(pw, { ...rt, llm_tokens: 1200 }, 4);
    expect(text).toContain('not the comparison this harness claims to make');
    expect(text).not.toContain('Both cost ZERO LLM tokens');
  });
});
