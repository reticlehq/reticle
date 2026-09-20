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

/**
 * A run that only REPLAYED is not a run that did nothing.
 *
 * "Nothing was driven" was true of the actions and wrong about the run: sixteen recorded journeys
 * replayed deterministically, for zero model tokens, and the report called it empty — while the
 * tool advised raising `maxSteps`, as though the cheap half of the plan working were a failure.
 */
describe('a run that replayed rather than drove', () => {
  const replay = (name: string, status?: string): ToolOutcome =>
    call('reticle_flow_replay', { flowName: name }, status === undefined ? {} : { status });

  it('reports the replays as the result, not as an empty run', () => {
    const summary = describeDrive([replay('sign-in', 'ok'), replay('checkout', 'ok')], []);
    expect(summary).toContain('Replayed 2 recorded journey(s)');
    expect(summary).toContain('NO model in the loop');
    expect(summary).toContain('2 still hold');
    expect(summary).not.toContain('Nothing was driven');
  });

  /**
   * The verdict is `status`, not `passed`. Reading the wrong key reported ten replays as undecided
   * on a run where every one had answered — the same false-nothing this report exists to stop.
   */
  it('reads the verdict the replay tool actually returns', () => {
    expect(describeDrive([replay('sign-in', 'ok')], [])).toContain('1 still hold');
  });

  it('names a journey that failed, as a regression', () => {
    const summary = describeDrive([replay('sign-in', 'ok'), replay('checkout', 'error')], []);
    expect(summary).toContain('1 failed');
    expect(summary).toContain('FAILED: checkout');
    expect(summary).toContain('regressions');
  });

  /** Drift is the app moving under a recording — fixing the app would be fixing working code. */
  it('keeps drift apart from failure, and says which needs the fix', () => {
    const summary = describeDrive([replay('sign-in', 'drift')], []);
    expect(summary).toContain('1 drifted');
    expect(summary).toContain('re-anchoring, not the app fixing');
    expect(summary).not.toContain('regressions');
  });

  it('counts a replay the tool refused as a failure rather than a pass', () => {
    const refused: ToolOutcome = {
      id: 'x',
      name: 'reticle_flow_replay',
      args: { flowName: 'gone' },
      result: { error: 'no such flow' },
      isError: true,
    };
    expect(describeDrive([refused], [])).toContain('1 failed');
  });

  it('reports replays alongside actions when the run did both', () => {
    const summary = describeDrive([replay('sign-in', 'ok'), acted('button "X"', 'yes')], []);
    expect(summary).toContain('Replayed 1 recorded journey(s)');
    expect(summary).toContain('1 proved');
  });

  it('still says plainly when a run did neither', () => {
    expect(describeDrive([], [])).toContain('nothing was replayed');
  });
});

/**
 * A red that does not say what was claimed is not triageable.
 *
 * "3 action(s) FAILED — the app did not do what the drive declared it would" is either three
 * defects or three wrong guesses, and those need opposite responses. This got sharper the day the
 * driver started declaring SPECIFIC consequences: a bare "something happened" is nearly always
 * satisfied, while "a POST request" can be wrong about a control that legitimately does not post.
 */
describe('a failed action says what it expected', () => {
  const failed = (until: unknown) => [
    call(
      'reticle_act_and_wait',
      { ref: 'e5', action: 'click', intent: 'click button "Save"', until },
      { verified: 'no', because: 'no request was observed' },
    ),
  ];

  it('names a declared signal', () => {
    const text = describeDrive(failed({ kind: 'signal', name: 'order:placed' }), []);
    expect(text).toContain('claimed signal order:placed');
  });

  it('names the method of a declared request', () => {
    expect(describeDrive(failed({ kind: 'net', method: 'POST' }), [])).toContain(
      'claimed a POST request',
    );
  });

  it('reads a route negation as leaving the page', () => {
    const text = describeDrive(
      failed({ kind: 'not', predicate: { kind: 'route', contains: '/settings' } }),
      [],
    );
    expect(text).toContain('claimed to leave');
  });

  /**
   * `no-fault` without the claim is unreadable: "the consequence was already true" about WHAT? It
   * is the line that exposed a GET offer being satisfied by a dashboard's own background polling,
   * seven times in one run.
   */
  it('names the claim behind a no-fault too, not just behind a red', () => {
    const noFault = [
      call(
        'reticle_act_and_wait',
        { ref: 'e5', action: 'click', intent: 'click x', until: { kind: 'net', method: 'GET' } },
        { verified: 'no-fault', because: 'the declared consequence was already true' },
      ),
    ];
    expect(describeDrive(noFault, [])).toContain('claimed a GET request');
  });

  /** A pass does not need it, and this report is read on every drive. */
  it('stays quiet about the claim when the action passed', () => {
    const passed = [
      call(
        'reticle_act_and_wait',
        { ref: 'e5', action: 'click', intent: 'click x', until: { kind: 'net', method: 'POST' } },
        { verified: 'yes', because: 'POST /api/save' },
      ),
    ];
    expect(describeDrive(passed, [])).not.toContain('claimed');
  });
});
