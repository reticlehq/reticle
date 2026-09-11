import { describe, expect, it } from 'vitest';
import {
  canonicalTarget,
  claimPolarity,
  falseGreens,
  isReadOnly,
  propagationDepth,
  reQueryRate,
  scoreRun,
  spread,
  stepsToCorrect,
  summarizeArm,
} from './intent-effect-metrics.mjs';

/** The scenario the runner injects: a nav that silently does nothing, so Compose never renders. */
const SCENARIO = {
  injected: true,
  subject: /compose/i,
  symptom: /compose[^.]{0,60}(never|not|fail|broken|does not|doesn't|blank|empty)/i,
};
const clean = { ...SCENARIO, injected: false };

const call = (tool, target = '{}', ok = true) => ({ kind: 'call', tool, target, ok, text: '' });
const claim = (text) => ({ kind: 'claim', text });

describe('isReadOnly', () => {
  it('classifies looks as reads and acts as not', () => {
    expect(isReadOnly('reticle_query')).toBe(true);
    expect(isReadOnly('reticle_snapshot')).toBe(true);
    expect(isReadOnly('reticle_context')).toBe(true);
    expect(isReadOnly('reticle_act_and_wait')).toBe(false);
    expect(isReadOnly('reticle_assert')).toBe(false);
  });

  /** Blocking on a future condition is not re-fetching an established fact. */
  it('does not treat wait_for or network_mock as reads', () => {
    expect(isReadOnly('reticle_wait_for')).toBe(false);
    expect(isReadOnly('reticle_network_mock')).toBe(false);
  });
});

describe('canonicalTarget', () => {
  it('makes key order irrelevant so the same call compares equal', () => {
    expect(canonicalTarget({ a: 1, b: 2 })).toBe(canonicalTarget({ b: 2, a: 1 }));
  });

  it('ignores sessionId, which names the tab and not the subject', () => {
    expect(canonicalTarget({ name: 'Compose', sessionId: 'x' })).toBe(
      canonicalTarget({ name: 'Compose' }),
    );
  });
});

describe('reQueryRate', () => {
  it('counts a read of something the run already established', () => {
    const r = reQueryRate([call('reticle_query', 'a'), call('reticle_query', 'a')]);
    expect(r).toMatchObject({ reads: 2, repeats: 1, rate: 0.5 });
  });

  it('does not count a read of a different target', () => {
    const r = reQueryRate([call('reticle_query', 'a'), call('reticle_query', 'b')]);
    expect(r).toMatchObject({ reads: 2, repeats: 0, rate: 0 });
  });

  it('ignores acting calls entirely — repeating an action is not redundancy', () => {
    const r = reQueryRate([
      call('reticle_act_and_wait', 'a'),
      call('reticle_act_and_wait', 'a'),
      call('reticle_query', 'b'),
    ]);
    expect(r).toMatchObject({ reads: 1, repeats: 0 });
  });

  /** A call that failed established nothing, so asking again is the first real look. */
  it('does not count a repeat of a call that errored', () => {
    const r = reQueryRate([
      call('reticle_query', 'a', false),
      call('reticle_query', 'a'),
      call('reticle_query', 'a'),
    ]);
    expect(r).toMatchObject({ reads: 3, repeats: 1 });
  });

  it('is null and not zero when the run made no reads at all', () => {
    expect(reQueryRate([call('reticle_act', 'a')]).rate).toBe(null);
    expect(reQueryRate([]).rate).toBe(null);
  });
});

describe('claimPolarity', () => {
  it('reads the verdict protocol', () => {
    expect(claimPolarity('VERDICT: PASS')).toBe('clean');
    expect(claimPolarity('VERDICT: FAIL')).toBe('broken');
  });

  it('prefers broken, because a negation carries the clean word too', () => {
    expect(claimPolarity('the Compose view does not render')).toBe('broken');
  });

  it('is null for a message that settles nothing, and not for one that does', () => {
    expect(claimPolarity('let me look at the deployments list')).toBe(null);
    expect(claimPolarity('the deployments list renders')).toBe('clean');
  });
});

describe('stepsToCorrect', () => {
  it('counts tool calls before the first true statement about the live defect', () => {
    const r = stepsToCorrect(
      [call('reticle_query'), call('reticle_act_and_wait'), claim('Compose never renders')],
      SCENARIO,
    );
    expect(r).toMatchObject({ caught: true, calls: 2, falseAlarm: false });
  });

  /**
   * THE NEGATIVE CONTROL. The identical transcript, with the defect NOT injected, must not be
   * scored as a catch — ground truth decides, never the string. This is the mistake
   * `network-timeout` shipped twice, both times flattering us.
   */
  it('scores the SAME transcript as a false alarm when the defect was not injected', () => {
    const steps = [call('reticle_query'), claim('Compose never renders')];
    expect(stepsToCorrect(steps, SCENARIO)).toMatchObject({ caught: true, calls: 1 });
    expect(stepsToCorrect(steps, clean)).toMatchObject({
      caught: false,
      calls: null,
      falseAlarm: true,
    });
  });

  it('reports no catch and no number when the defect was never named', () => {
    const r = stepsToCorrect([call('reticle_query'), claim('VERDICT: PASS')], SCENARIO);
    expect(r).toMatchObject({ caught: false, calls: null, falseAlarm: false });
  });
});

describe('falseGreens', () => {
  it('counts a clean verdict over a live defect as a false green', () => {
    expect(falseGreens([claim('VERDICT: PASS')], SCENARIO)).toMatchObject({
      claims: 1,
      wrong: 1,
      rate: 1,
    });
  });

  it('does not count a correct FAIL verdict', () => {
    expect(falseGreens([claim('VERDICT: FAIL')], SCENARIO)).toMatchObject({ claims: 1, wrong: 0 });
  });

  /** Nothing is wrong with calling a healthy app healthy — ground truth says the defect is absent. */
  it('does not count a clean verdict on a clean app', () => {
    expect(falseGreens([claim('VERDICT: PASS')], clean)).toMatchObject({ claims: 1, wrong: 0 });
  });

  /** Otherwise both arms fill up with true statements about parts the defect never touched. */
  it('ignores a clean claim about a subject the defect does not live in', () => {
    const steps = [
      claim('the Overview KPI cards render fine'),
      claim('the Compose view renders fine'),
    ];
    // Only the second claim is about the defect's subject, so the scoping is selective and not a
    // blanket zero — a grader that counted neither would pass a weaker version of this test.
    expect(falseGreens(steps, SCENARIO)).toMatchObject({ claims: 1, wrong: 1 });
  });

  it('counts a clean claim about the defect subject even without a verdict line', () => {
    expect(falseGreens([claim('the Compose view renders correctly')], SCENARIO)).toMatchObject({
      claims: 1,
      wrong: 1,
    });
  });

  it('is null and not zero when the run settled nothing', () => {
    expect(falseGreens([claim('looking now')], SCENARIO).rate).toBe(null);
  });
});

describe('propagationDepth', () => {
  /** The thesis as arithmetic: an action, then a verdict, with nothing looked at in between. */
  it('finds a claim made with no observation since the last action', () => {
    const r = propagationDepth([
      call('reticle_act_and_wait'),
      claim('VERDICT: PASS'),
      call('reticle_act'),
      call('reticle_act'),
    ]);
    expect(r).toMatchObject({ firstUngroundedStep: 1, depth: 2, selfCorrected: false });
  });

  it('does not flag a claim that a read backs up', () => {
    const r = propagationDepth([
      call('reticle_act_and_wait'),
      call('reticle_snapshot'),
      claim('VERDICT: PASS'),
    ]);
    expect(r).toMatchObject({ firstUngroundedStep: null, depth: null });
  });

  it('stops the depth at a grounded claim of the opposite polarity', () => {
    const r = propagationDepth([
      call('reticle_act'),
      claim('VERDICT: PASS'),
      call('reticle_act'),
      call('reticle_snapshot'),
      claim('VERDICT: FAIL'),
      call('reticle_act'),
    ]);
    expect(r).toMatchObject({ firstUngroundedStep: 1, depth: 2, selfCorrected: true });
  });

  /** An unproven retraction is not a self-correction; it is a second ungrounded claim. */
  it('does not accept an ungrounded reversal as a self-correction', () => {
    const r = propagationDepth([
      call('reticle_act'),
      claim('VERDICT: PASS'),
      call('reticle_act'),
      claim('VERDICT: FAIL'),
    ]);
    expect(r.selfCorrected).toBe(false);
  });
});

describe('spread', () => {
  it('is the range across runs', () => {
    expect(spread([0.2, 0.5, 0.4])).toBe(0.3);
  });

  it('is null with fewer than two values, because one run has no observed variance', () => {
    expect(spread([0.5])).toBe(null);
    expect(spread([0.5, null])).toBe(null);
    expect(spread([])).toBe(null);
  });
});

describe('summarizeArm', () => {
  const steps = [call('reticle_act'), claim('VERDICT: PASS')];

  /** Absent is not zero — the defect tool-coverage.mjs exists to prevent, restated for arms. */
  it('marks an arm that did not run as absent rather than scoring it zero', () => {
    const arm = summarizeArm([]);
    expect(arm.present).toBe(false);
    expect(arm.false_green_rate).toBe(undefined);
  });

  it('folds per-run scores and keeps every run visible', () => {
    const arm = summarizeArm([scoreRun(steps, SCENARIO), scoreRun(steps, SCENARIO)]);
    expect(arm).toMatchObject({
      present: true,
      runs: 2,
      false_green_claims: 2,
      false_greens: 2,
      false_green_rate: 1,
      false_green_spread: 0,
    });
    expect(arm.false_green_rate_per_run).toEqual([1, 1]);
  });
});
