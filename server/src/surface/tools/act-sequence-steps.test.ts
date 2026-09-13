/**
 * A sequence that cannot act must say so, not report success.
 *
 * `steps` is a bare array of objects. A step with neither `ref` nor `target` used to dispatch as
 * `ref: ''` and fail with a stale-ref diagnosis. `target` is accepted — it is the same locator
 * `reticle_act` takes — and a step that names neither is still refused before the first dispatch,
 * so a typo in step three cannot leave one and two applied.
 */
import { describe, expect, it } from 'vitest';
import { assertSequenceSteps } from './act/act-preflight.js';
import { describeStepResult } from './act/act-sequence-retry.js';

describe('refusing a sequence that cannot act', () => {
  it('accepts a step written with `target` instead of `ref`', () => {
    expect(() =>
      assertSequenceSteps([{ target: { testid: 'auth-email' }, action: 'fill' }]),
    ).not.toThrow();
  });

  it('accepts a mixed sequence of refs and targets', () => {
    expect(() =>
      assertSequenceSteps([
        { target: { label: 'Email' }, action: 'fill' },
        { ref: 'e2', action: 'fill' },
        { target: { testid: 'submit' }, action: 'click' },
      ]),
    ).not.toThrow();
  });

  it('names WHICH step is wrong', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill' },
        { ref: 'e2', action: 'fill' },
        { action: 'click' },
      ]),
    ).toThrow(/step 2/);
  });

  it('refuses the WHOLE sequence, so a bad step three cannot leave one and two applied', () => {
    // Checked before the first dispatch. Half a journey is worse than none: the page has moved and
    // nothing says how far.
    expect(() => assertSequenceSteps([{ ref: 'e1', action: 'fill' }, { action: 'click' }])).toThrow(
      /Nothing was acted on/,
    );
  });

  it('refuses an empty step list rather than reporting a successful no-op', () => {
    expect(() => assertSequenceSteps([])).toThrow(/no steps/);
  });

  it('refuses a step with an empty ref and no target', () => {
    expect(() => assertSequenceSteps([{ ref: '', action: 'click' }])).toThrow(
      /no `ref` or `target`/,
    );
  });

  it('accepts an empty ref when a target is present', () => {
    // resolveActTarget treats an empty ref as missing and falls through to target.
    expect(() =>
      assertSequenceSteps([{ ref: '', target: { label: 'Email' }, action: 'fill' }]),
    ).not.toThrow();
  });

  it('refuses junk in the steps array', () => {
    for (const junk of [null, 'a step', 42, []]) {
      expect(() => assertSequenceSteps([junk]), JSON.stringify(junk)).toThrow();
    }
  });

  it('accepts a well-formed sequence', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill', args: { value: 'a@b.com' } },
        { ref: 'e2', action: 'click' },
      ]),
    ).not.toThrow();
  });

  it('accepts a document-key press with neither ref nor target', () => {
    expect(() =>
      assertSequenceSteps([{ action: 'press', args: { text: 'Escape' } }]),
    ).not.toThrow();
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'click' },
        { action: 'press', args: { text: 'k', modifiers: ['Meta'] } },
      ]),
    ).not.toThrow();
  });

  it('still refuses a default Enter press with no locator — that key submits a control', () => {
    expect(() => assertSequenceSteps([{ action: 'press', args: { text: 'Enter' } }])).toThrow(
      /no `ref` or `target`/,
    );
  });
});

describe('what a step reports', () => {
  it('falls back to the step’s own ref and action when the act did not echo them', () => {
    const out = describeStepResult({ ref: 'e1', action: 'fill' }, {});
    expect(out['ref']).toBe('e1');
    expect(out['action']).toBe('fill');
  });

  it('prefers what the act actually reported', () => {
    const out = describeStepResult({ ref: 'e1', action: 'fill' }, { ref: 'e9', action: 'type' });
    expect(out['ref']).toBe('e9');
    expect(out['action']).toBe('type');
  });

  it('omits fields the act did not produce, rather than filling a row with nulls', () => {
    // A row of nulls reads as "we looked and found nothing" instead of "there was nothing to look for".
    const out = describeStepResult({ ref: 'e1', action: 'click' }, {});
    expect('testid' in out).toBe(false);
    expect('warning' in out).toBe(false);
  });

  it('carries the identifying fields when they are there', () => {
    const out = describeStepResult(
      { ref: 'e1', action: 'click' },
      { testid: 'submit', role: 'button', name: 'Sign In', source: 'src/x.tsx:1' },
    );
    expect(out['testid']).toBe('submit');
    expect(out['name']).toBe('Sign In');
  });
});

/**
 * A sub-step reads `{ ref | target, action, args }` and NOTHING else. The schema is
 * `z.record(z.unknown())`, so any other key is accepted and dropped — and the keys an agent is most
 * likely to reach for are the ones that claim a consequence, because `until` is what the neighbouring
 * act_and_wait calls its assertion.
 *
 * Driven against the Electron fixture, a step carrying `until: { kind: 'net', urlContains:
 * 'this-endpoint-does-not-exist-at-all' }` returned `completed: 1` with no error and no mention of
 * the predicate. The endpoint cannot exist, so the assertion could never hold; nothing evaluated it.
 * An agent reads `completed` plus `settled: true` and records a consequence that was never checked.
 *
 * The honest answer is to refuse and name the key that IS read, the same way an unsupported native
 * click is refused rather than faked. `expect` was on this list until the tool learned to grade one
 * per step — see the block below, and the live drive that found the door still locked.
 */
describe('a sub-step cannot silently carry an assertion it will never grade', () => {
  for (const key of ['until', 'assert', 'waitFor']) {
    it(`refuses a step carrying \`${key}\``, () => {
      expect(() =>
        assertSequenceSteps([{ ref: 'e1', action: 'click', [key]: { kind: 'settled' } }]),
      ).toThrow(/does not read[\s\S]*`expect`/);
    });
  }

  it('names the offending step and key so the caller can fix it', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'click' },
        { ref: 'e2', action: 'click', until: {} },
      ]),
    ).toThrow(/step 1[\s\S]*until/);
  });

  it('still accepts the documented shape', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill', args: { value: 'a' } },
        { target: { testid: 't' }, action: 'click' },
      ]),
    ).not.toThrow();
  });
});

/**
 * The preflight was written when a sub-step genuinely could not be graded, and stayed that way after
 * it could.
 *
 * `reticle_act_sequence` now takes `expect` per step, parses it, grades it, and returns
 * `stopped_at` — and its own schema tells the agent so: *"`expect` … is what makes a step PROVE
 * something"*. The preflight runs first and refused every step carrying one, so an agent following
 * the tool's own documentation got a hard refusal and the whole graded path was unreachable.
 *
 * No unit test could see it: they call `gradeSequence` and the handler internals directly. It took a
 * live drive of a three-step plan to hit the door that was still locked.
 *
 * The other three keys stay refused. `until`, `assert` and `waitFor` are still keys this tool does
 * not read, and silently dropping one manufactures the false green the refusal exists to stop — but
 * the answer is now "you want `expect`", not "go and use another tool".
 */
describe('the consequence an agent declares on a sub-step', () => {
  const expectStep = {
    ref: 'e1',
    action: 'click',
    expect: { kind: 'signal', name: 'todo:added' },
  };

  it('accepts `expect`, which this tool grades', () => {
    expect(() => assertSequenceSteps([expectStep])).not.toThrow();
  });

  it('accepts it beside steps that declare nothing', () => {
    expect(() =>
      assertSequenceSteps([{ ref: 'e0', action: 'fill', args: { value: 'a' } }, expectStep]),
    ).not.toThrow();
  });

  for (const key of ['until', 'assert', 'waitFor']) {
    it(`still refuses \`${key}\`, which is read by nothing and would be dropped`, () => {
      expect(() =>
        assertSequenceSteps([{ ref: 'e1', action: 'click', [key]: { kind: 'signal', name: 'x' } }]),
      ).toThrow(/expect/);
    });
  }
});

/**
 * An `expect` the tool cannot parse must be REFUSED, never counted as nothing declared.
 *
 * The handler used `PredicateSchema.safeParse` and, on failure, pushed `{ declared: false }`. So an
 * agent that wrote `expect: { signal: "order:placed" }` — a plausible spelling, and wrong, the
 * shape is `{ kind: "signal", name: ... }` — got back *"all 3 steps declared nothing, so the app was
 * driven but not verified"*. It had declared. Nobody told it the declaration was thrown away, and
 * the sentence it did get invites it to add the very thing it just wrote.
 *
 * That is the same false green the unreadable-key refusal above exists to prevent, arriving through
 * a key the tool DOES read. Measured on a live daemon, which is also the only place it shows: the
 * handler tests construct predicates that parse.
 *
 * Refused in the preflight, before the first dispatch, for the reason every other refusal here is:
 * half a journey is worse than none.
 */
describe('an expect this tool cannot parse', () => {
  it('refuses a plausible but wrong predicate spelling', () => {
    expect(() =>
      assertSequenceSteps([{ ref: 'e1', action: 'click', expect: { signal: 'order:placed' } }]),
    ).toThrow(/step 0[\s\S]*expect/);
  });

  it('names what a predicate looks like, so the fix does not need another round trip', () => {
    expect(() =>
      assertSequenceSteps([{ ref: 'e1', action: 'click', expect: { signal: 'order:placed' } }]),
    ).toThrow(/kind/);
  });

  it('refuses rather than dropping it, so nothing is acted on', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill', args: { value: 'a' } },
        { ref: 'e2', action: 'click', expect: 'the receipt appears' },
      ]),
    ).toThrow(/Nothing was acted on/);
  });

  it('still accepts every predicate the grader understands', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'click', expect: { kind: 'signal', name: 'order:placed' } },
        { ref: 'e2', action: 'click', expect: { kind: 'element', by: 'testid', value: 'receipt' } },
        { ref: 'e3', action: 'click', expect: { kind: 'settled' } },
      ]),
    ).not.toThrow();
  });
});
