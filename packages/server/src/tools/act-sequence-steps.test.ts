/**
 * A sequence that cannot act must say so, not report success.
 *
 * `steps` is validated as a bare array of objects, so a step written with `target` — the locator the
 * single-action tools take — passed the schema, found no `ref`, and was skipped. The call returned
 * `steps: []` and no error: an entire login journey doing NOTHING while reporting success.
 *
 * Found by driving this project's own dashboard, where exactly that happened — the form submitted an
 * empty email and the failure surfaced three screens later as a mystery 401.
 *
 * A `target` step is now ACTED ON rather than refused (#702): the refusal was the honest half-fix,
 * and the asymmetry it explained still cost a round trip per field. What must never come back is the
 * original defect — a step this tool cannot address being skipped while the call reports success —
 * so the cases below moved from "refuses target" to "refuses a step it cannot address at all".
 */
import { describe, expect, it } from 'vitest';
import { assertSequenceSteps } from './act-preflight.js';
import { describeStepResult } from './act-sequence-retry.js';

describe('refusing a sequence that cannot act', () => {
  it('accepts a step addressed by `target`, which it now resolves', () => {
    expect(() =>
      assertSequenceSteps([{ target: { testid: 'auth-email' }, action: 'fill' }]),
    ).not.toThrow();
  });

  it('names BOTH ways to address a step when one has neither', () => {
    // The recovery has to name the option the caller did not use, or the message only says no.
    try {
      assertSequenceSteps([{ action: 'click' }]);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('ref');
      expect((e as Error).message).toContain('target');
    }
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
    // An empty string is not an address. It reached the browser as `ref: ''` and came back as
    // "ref '' no longer resolves to an element", which sends the reader looking for a re-render.
    expect(() => assertSequenceSteps([{ ref: '', action: 'click' }])).toThrow(/neither/);
  });

  it('accepts an empty ref when the step also carries a target', () => {
    // `resolveActTarget` prefers a non-empty ref and falls through to the target otherwise, so a
    // caller who sends both with an empty ref is addressed rather than refused.
    expect(() =>
      assertSequenceSteps([{ ref: '', target: { testid: 'x' }, action: 'click' }]),
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
