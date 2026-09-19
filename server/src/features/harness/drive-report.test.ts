import { describe, expect, it } from 'vitest';
import { describeDrive, drivenSteps } from './drive-report.js';
import type { ToolOutcome } from './harness.js';

/**
 * The account an agent reads is derived from evidence, so these tests are mostly about the two ways
 * a derived account could still mislead: letting a count of actions read as a count of successes,
 * and letting `unknown` read as either a pass or a failure.
 */

const call = (
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  isError = false,
): ToolOutcome => ({ id: `c-${name}`, name, args, result, isError });

const acted = (target: string, verified: string, because = 'evidence') =>
  call(
    'reticle_act_and_wait',
    { ref: 'e1', action: 'click' },
    { element: target, verified, because },
  );

describe('reducing a drive to what it did', () => {
  it('keeps only the calls that drove the app', () => {
    const steps = drivenSteps([
      call('reticle_snapshot', { mode: 'interactive' }, { tree: '' }),
      call('reticle_observe', {}, {}),
      acted('button "Create"', 'yes'),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.target).toBe('button "Create"');
  });

  /** A ref is a handle that expired when the page changed; it means nothing to tomorrow's reader. */
  it('prefers a name a person could read over the ref', () => {
    const named = drivenSteps([acted('button "Create"', 'yes')]);
    expect(named[0]?.target).toBe('button "Create"');

    const unnamed = drivenSteps([
      call('reticle_act_and_wait', { ref: 'e42', action: 'click' }, { verified: 'yes' }),
    ]);
    expect(unnamed[0]?.target).toBe('e42');
  });

  it('records a failed call as an error rather than dropping it', () => {
    const steps = drivenSteps([
      call('reticle_act_and_wait', { ref: 'e1', action: 'click' }, { error: 'no such ref' }, true),
    ]);
    expect(steps[0]?.verified).toBe('error');
    expect(steps[0]?.because).toBe('no such ref');
  });
});

describe('the account an agent reads', () => {
  it('says plainly that nothing was driven', () => {
    expect(describeDrive([], [])).toContain('Nothing was driven');
  });

  /**
   * The whole point. Twelve actions driven is not twelve things working, and an account that only
   * counted actions would be read as if it were.
   */
  it('counts proved, failed and not-proved separately', () => {
    const summary = describeDrive(
      [acted('a', 'yes'), acted('b', 'no'), acted('c', 'unknown'), acted('d', 'yes')],
      [],
    );
    expect(summary).toContain('4 action(s): 2 proved, 1 failed, 1 not decided');
  });

  it('calls a failure a finding', () => {
    const summary = describeDrive([acted('a', 'no', 'the button stayed disabled')], []);
    expect(summary).toContain('FAILED');
    expect(summary).toContain('These are findings');
    expect(summary).toContain('the button stayed disabled');
  });

  /**
   * `unknown` means the evidence could not decide. Reported as a failure it sends an agent to
   * rewrite working code; reported as a pass it is a false green. It has to read as neither.
   */
  it('reports an undecided action as not proved, and not as a failure', () => {
    const summary = describeDrive([acted('a', 'unknown', 'the page never settled')], []);
    expect(summary).toContain('NOT PROVED');
    expect(summary).toContain('not a failure');
    expect(summary).not.toContain('These are findings');
  });

  it('treats an action that declared nothing as not proved', () => {
    const summary = describeDrive(
      [call('reticle_act', { ref: 'e1', action: 'click' }, { element: 'button "X"' })],
      [],
    );
    expect(summary).toContain('0 proved');
    expect(summary).toContain('nothing declared');
  });

  it('tells the reader how to replay it without a model', () => {
    const summary = describeDrive([acted('a', 'yes')], ['sign-in']);
    expect(summary).toContain('reticle_verify { action: "flows" }');
    expect(summary).toContain('sign-in');
  });

  it('stops naming steps once there are too many to read, and says how many it left out', () => {
    const many = Array.from({ length: 20 }, (_, i) => acted(`button ${String(i)}`, 'yes'));
    const summary = describeDrive(many, []);
    expect(summary).toContain('20 action(s): 20 proved');
    expect(summary).toContain('and 8 more');
  });

  it('names a navigation by where it went', () => {
    const summary = describeDrive(
      [call('reticle_navigate', { url: 'http://localhost:4312/orders' }, { verified: 'yes' })],
      [],
    );
    expect(summary).toContain('navigate http://localhost:4312/orders');
  });
});
