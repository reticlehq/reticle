import { invokedFlowMissing } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';
import {
  checkTally,
  describeDrive,
  drivenSteps,
  runProved,
  typedValues,
  verdictLine,
} from './drive-report.js';
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
    { ref: 'e1', action: 'click', until: { kind: 'signal', name: target } },
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

  /*
   * Persona 22: a read-only persona's run navigated between two pages and its summary said "Nothing
   * was driven… no action against the app". A navigation is an action against the app, however the
   * drive reached the tool.
   */
  it('counts a navigation made through reticle_run as driving', () => {
    const summary = describeDrive(
      [
        call(
          'reticle_run',
          { tool: 'reticle_navigate', args: { url: '/share/abc' } },
          { confirmed: true },
        ),
      ],
      [],
    );
    expect(summary).not.toContain('Nothing was driven');
    expect(summary).toContain('Drove 1 action(s)');
    expect(summary).toContain('/share/abc');
  });

  /**
   * The whole point. Twelve actions driven is not twelve things working, and an account that only
   * counted actions would be read as if it were.
   */
  // Counted once, in the checks line: a second breakdown on the action line ("3 of 3 check(s)
  // held" beside "Drove 2 action(s): 2 proved") gave every Harness answer two counts to reconcile.
  it('counts held, failed and undecided once, in the checks line', () => {
    const summary = describeDrive(
      [acted('a', 'yes'), acted('b', 'no'), acted('c', 'unknown'), acted('d', 'yes')],
      [],
    );
    expect(summary).toContain('check(s) held, 1 failed, 1 undecided');
    expect(summary).toContain('Drove 4 action(s).');
    expect(summary).not.toContain('2 proved');
  });

  it('says which saved flows check nothing, instead of offering them as replays', () => {
    const summary = describeDrive(
      [acted('a', 'unknown')],
      ['harness-drive-home', 'login'],
      ['harness-drive-home'],
    );
    expect(summary).toContain('harness-drive-home checks nothing');
    expect(summary).toContain('saved login');
    expect(summary).not.toContain('saved harness-drive-home, login');
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
    expect(summary).toContain('Drove 1 action(s).');
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
    expect(summary).toContain('Drove 20 action(s).');
    expect(summary).toContain('and 8 more');
  });

  /** From a recorded whole-app run: its failures sat in "… and 58 more", unreadable. */
  it('lists every failure first, however long the run', () => {
    const steps = [
      ...Array.from({ length: 20 }, (_, i) => acted(`ok ${String(i)}`, 'yes')),
      ...Array.from({ length: 15 }, (_, i) => acted(`bad ${String(i)}`, 'no')),
    ];
    const summary = describeDrive(steps, []);
    for (let i = 0; i < 15; i += 1) expect(summary).toContain(`bad ${String(i)}`);
    expect(summary).toContain('and 20 more, none of them failed');
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
    expect(summary).toContain('Drove 1 action(s)');
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

/*
 * Nothing said how DEEP a drive got. "Drove 11 actions: 3 proved" reads the same whether the drive
 * walked a checkout to its receipt or clicked eleven things on the home page.
 */
describe('the report says how far into the app the drive got', () => {
  const looked = (route: string) =>
    call('reticle_snapshot', { mode: 'interactive' }, { tree: '', status: { route } });

  it('names the pages reached, in order, without repeats', () => {
    const report = describeDrive(
      [
        looked('/cart'),
        acted('Checkout', 'yes'),
        looked('/shipping'),
        looked('/shipping'),
        looked('/payment'),
      ],
      [],
    );
    expect(report).toContain('Reached 3 page(s): /cart → /shipping → /payment');
  });

  it('says so plainly when the drive never left its first page', () => {
    const report = describeDrive([looked('/home'), acted('Save', 'yes')], []);
    expect(report).toContain('Reached 1 page(s): /home');
  });
});

/**
 * Found driving the merchant dashboard: the Harness's own act result named a refund sent at 1/100th
 * of its amount, fired twice, and a settings save refused with a 422. Its report kept the verdict
 * word and dropped all three, then ended "proved its checks", and the caller reported no defect.
 */
describe('the evidence travels with the verdict', () => {
  const refund = call(
    'reticle_act_and_wait',
    { ref: 'e523', action: 'click', until: { kind: 'net', method: 'POST' } },
    {
      element: 'button "Refund now"',
      verified: 'no',
      because: 'channels disagree about this action (unit-mismatch)',
      contradictions: [
        {
          kind: 'unit-mismatch',
          counter: 'the value sent is 100x SMALLER',
          detail: '/api/v1/payments/pay_1/refund',
        },
        { kind: 'duplicate-request', counter: 'the same write fired 2 times', detail: 'POST ×2' },
      ],
    },
  );
  const save = call(
    'reticle_act_and_wait',
    { ref: 'e539', action: 'check', until: { kind: 'net', method: 'PATCH' } },
    {
      verified: 'no',
      verdict: {
        pass: true,
        evidence: {
          method: 'PATCH',
          url: '/api/v1/settings',
          status: 422,
          responseBody: '{"error":"requires KYC level 2"}',
        },
      },
    },
  );
  const navigated = call(
    'reticle_act_and_wait',
    { ref: 'e85', action: 'click', until: { kind: 'route', contains: 'settings' } },
    { verified: 'yes' },
  );

  it('names each disagreement and each failed write under the step', () => {
    const summary = describeDrive([refund, save, navigated], []);
    expect(summary).toContain('unit-mismatch: the value sent is 100x SMALLER');
    expect(summary).toContain('duplicate-request: the same write fired 2 times');
    expect(summary).toContain('PATCH /api/v1/settings → 422 {"error":"requires KYC level 2"}');
  });

  it('leads with NOT PROVED when one check passed and two failed', () => {
    const summary = describeDrive([refund, save, navigated], []);
    expect(summary.split('\n')[0]).toBe(
      'NOT PROVED — 1 of 3 check(s) held, 2 failed, 0 undecided. The failures below are findings.',
    );
  });

  it('does not call a replay stopped at a destructive step a regression', () => {
    const guarded = call(
      'reticle_flow_replay',
      { flowName: 'refund-flow' },
      {
        status: 'error',
        error: {
          message: 'potentially destructive action blocked; retry with args.confirmDangerous=true',
        },
      },
    );
    const summary = describeDrive([guarded], []);
    expect(summary).toContain('NOT RUN: refund-flow');
    expect(summary).not.toContain('regressions');
  });
});

describe('a destructive click the gate refused, then the drive confirmed', () => {
  it('lists the click once, and says it really ran', () => {
    const refused = call(
      'reticle_act_and_wait',
      { ref: 'e119', action: 'click' },
      { error: 'potentially destructive action blocked; retry with args.confirmDangerous=true' },
      true,
    );
    const ran = call(
      'reticle_act_and_wait',
      {
        ref: 'e119',
        action: 'click',
        args: { confirmDangerous: true },
        until: { kind: 'net', method: 'POST' },
      },
      { element: 'button "Refund now"', verified: 'no' },
    );
    const summary = describeDrive([refused, ran], []);
    expect(summary).not.toContain('potentially destructive action blocked');
    expect(summary).toContain('1 destructive action(s) were confirmed and REALLY RAN');
    expect(summary).toContain('Drove 1 action(s)');
  });
});

describe('a click that opened a confirmation instead of sending', () => {
  it('says the claim was likely wrong, not the app', () => {
    const summary = describeDrive(
      [
        call(
          'reticle_act_and_wait',
          { ref: 'e83', action: 'click', until: { kind: 'net', method: 'POST' } },
          { element: 'button "Refund"', verified: 'no' },
        ),
        call(
          'reticle_snapshot',
          {},
          { status: { route: '/#/t', visibleDialogs: ['(unnamed dialog)'] } },
        ),
      ],
      [],
    );
    expect(summary).toContain('it opened a dialog instead');
  });
});

describe('the pages a drive reached', () => {
  it('names the page, not the leased tab it was reached in', () => {
    const shot = (route: string) => call('reticle_snapshot', {}, { status: { route } });
    const summary = describeDrive(
      [
        shot('/?__reticle_session=lease-1&__reticle_project=p'),
        shot('/?__reticle_session=lease-1&__reticle_project=p#/settings'),
        call('reticle_act_and_wait', { ref: 'e1', action: 'click' }, { verified: 'yes' }),
      ],
      [],
    );
    expect(summary).toContain('Reached 2 page(s): / → /#/settings.');
    expect(summary).not.toContain('__reticle_');
  });
});

/** A false green from a live drive: one "Sign in" pressed fifteen times read as fifteen proofs. */
describe("the Harness's second press of a control whose claim already held", () => {
  // Save held its POST, the app emptied the field, Save was pressed again: no failure of the app.
  it('is undecided, never a failure', () => {
    const press = (verified: string) => ({
      id: 'x',
      name: 'reticle_act_and_wait',
      args: { ref: 'e138', action: 'click', until: { kind: 'net', method: 'POST' } },
      result: { verified },
      isError: false,
    });
    expect(checkTally([press('yes'), press('no')])).toEqual({ held: 1, failed: 0, undecided: 1 });
  });
});

describe('the same check made again', () => {
  // Counted as the platform counts a run's checks: distinct (kind, claim, outcome). The answer
  // said "2 of 2 held" beside a dashboard that counted the same run's checks differently.
  it('counts once per claim and outcome, as the platform counts them', () => {
    const press = (verified: string) => ({
      id: 'x',
      name: 'reticle_act_and_wait',
      args: { ref: 'e3', action: 'click', until: { kind: 'net', method: 'POST' } },
      result: { verified, effect: { role: 'button', name: 'Sign in' } },
      isError: false,
    });
    expect(checkTally(Array.from({ length: 15 }, () => press('yes')))).toEqual({
      held: 1,
      failed: 0,
      undecided: 0,
    });
    // The same control failing after it held is the Harness's own re-press: undecided.
    expect(checkTally([press('yes'), press('no'), press('yes')])).toEqual({
      held: 1,
      failed: 0,
      undecided: 1,
    });
    // Another control with the same claim is the same check to the platform.
    const other = { ...press('yes'), result: { verified: 'yes', effect: { testid: 'save' } } };
    expect(checkTally([press('yes'), other]).held).toBe(1);
  });
});

/*
 * Three runs whose every goal was met read "NOT PROVED … The failures below are findings": each
 * failure was the driver declaring that an in-page toggle would change the route.
 */
describe("the driver's wrong guess about the route", () => {
  const guessed = call(
    'reticle_act_and_wait',
    {
      ref: 'e127',
      action: 'click',
      until: { kind: 'not', predicate: { kind: 'route', contains: '/runs' } },
    },
    { element: 'button "Team"', verified: 'no', because: 'the declared consequence did not hold' },
  );
  const held = call(
    'reticle_assert',
    { predicate: { kind: 'text', contains: 'Done' } },
    { verified: 'yes' },
  );

  it('is not a failed check, a failed action or a finding', () => {
    expect(checkTally([guessed, held])).toEqual({ held: 1, failed: 0, undecided: 0 });
    const account = describeDrive([guessed, held], []);
    expect(account).toMatch(/^PROVED/);
    expect(account).not.toContain('FAILED');
    expect(account).not.toContain('findings');
    expect(account).toContain("the driver's wrong guess, not an app defect");
  });

  // A re-drive: "1 of 1 check(s) held" beside "Drove 2 action(s): 1 proved, 1 not decided" — the
  // guess was left out of one count and put in the other. One rule for both lines.
  it('is counted the same way in the action line as in the checks', () => {
    const account = describeDrive([guessed, held], []);
    expect(account).toContain('Drove 1 action(s); 1 guess of its own, not a check.');
    expect(account).toContain('1 guess of its own');
  });

  // Pressing the workspace switcher opens a menu; the route the drive named comes after a choice
  // in it. That is progress, never "the driver's wrong guess".
  it('is progress when the click opened a menu', () => {
    const menu = call(
      'reticle_snapshot',
      {},
      { status: { visibleDialogs: ['menu "Workspaces"'] } },
    );
    const account = describeDrive([guessed, menu, held], []);
    expect(account).not.toContain("the driver's wrong guess");
    expect(account).toContain('opened a menu');
  });

  it('still fails a click whose claim was more than a route', () => {
    const net = call(
      'reticle_act_and_wait',
      { ref: 'e1', action: 'click', until: { kind: 'net', method: 'POST' } },
      { verified: 'no' },
    );
    expect(checkTally([net]).failed).toBe(1);
  });
});

/** A run called flows missing on this computer "regressions in journeys that used to pass". */
describe('a replayed flow that is not on this computer', () => {
  it('is missing, not a failed journey', () => {
    const missing = call(
      'reticle_flow_replay',
      { flowName: 'checkout' },
      { error: 'no such flow on disk — run reticle_flow{action:"list"} to see saved flows' },
      true,
    );
    const account = describeDrive([missing], []);
    expect(account).toContain('MISSING: checkout');
    expect(account).not.toContain('regressions');
  });

  /*
   * Persona 25: an auto-saved flow called a flow that was never saved. Its replay failed at that
   * call, and the plan reported it among "regressions in journeys that used to pass": it never
   * passed, because it never ran.
   */
  it('is missing when the flow it calls is not on this computer, not a regression', () => {
    const calls = call(
      'reticle_flow_replay',
      { flowName: 'drive-order-confirmed' },
      { status: 'error', error: { code: 'error', message: invokedFlowMissing('harness-reload') } },
    );
    const account = describeDrive([calls], []);
    expect(account).toContain('MISSING: drive-order-confirmed');
    expect(account).not.toContain('regressions');
  });
});

/**
 * A plan run has one verdict, and it is its journeys'. A live run ended "0 of 1 journeys passed …
 * PROVED — 1 of 1 check(s) held" beside a dashboard that said Failed, and a passed replay ended
 * "1 of 1 journeys passed … NOT PROVED: the drive ran no check" beside one that said Passed.
 */
describe('a plan run has one verdict: its journeys', () => {
  const replay = (name: string, status: string): ToolOutcome =>
    call('reticle_flow_replay', { flowName: name }, { status });

  it('a failed journey is not proved, whatever its checks did', () => {
    const tally = { held: 1, failed: 0, undecided: 0 };
    const journeys = [{ status: 'failed' }];
    expect(verdictLine(tally, undefined, journeys)).toMatch(/^NOT PROVED/);
    expect(verdictLine(tally, undefined, journeys)).toContain('1 of 1 journey(s) failed');
    expect(runProved(tally, undefined, journeys)).toBe(false);
  });

  // A re-drive answered proved:true and "PROVED — 1 of 1 journey(s) passed" beside goalMet:false.
  it('passed journeys over a goal the run did not reach are not proved', () => {
    const tally = { held: 4, failed: 0, undecided: 0 };
    const journeys = [{ status: 'passed' }];
    expect(verdictLine(tally, false, journeys)).toMatch(/^NOT PROVED/);
    expect(verdictLine(tally, false, journeys)).toContain('the goal was not reached');
    expect(runProved(tally, false, journeys)).toBe(false);
  });

  it('a passed replay is proved, and its replay is the check it ran', () => {
    const tally = checkTally([replay('sign-in', 'ok')]);
    expect(tally).toEqual({ held: 1, failed: 0, undecided: 0 });
    const journeys = [{ status: 'passed' }];
    expect(verdictLine(tally, undefined, journeys)).toMatch(/^PROVED/);
    expect(runProved(tally, undefined, journeys)).toBe(true);
  });

  it('a replay that failed is a failed check, and one that drifted decided nothing', () => {
    expect(checkTally([replay('a', 'error'), replay('b', 'drift')])).toEqual({
      held: 0,
      failed: 1,
      undecided: 1,
    });
  });

  it('a plan whose journeys never ran proves nothing, like the dashboard', () => {
    expect(
      runProved({ held: 2, failed: 0, undecided: 0 }, undefined, [{ status: 'blocked' }]),
    ).toBe(false);
  });

  it('the account the agent reads leads with the same verdict', () => {
    const summary = describeDrive([replay('sign-in', 'ok')], [], [], undefined, [
      { status: 'passed' },
    ]);
    expect(summary).not.toContain('NOT PROVED');
  });
});

/**
 * A plan run's summary on the plan page read "Nothing was driven and nothing was replayed: the run
 * made no action against the app" while the HUD showed its replay. A plan run's summary leads with
 * its journeys' verdict, replays counted, whether or not anything was driven by the model.
 */
describe("a plan run's summary leads with its journeys", () => {
  const replay = (name: string, status: string): ToolOutcome =>
    call('reticle_flow_replay', { flowName: name }, { status });

  it('a replay-only run is summarised by its verdict and its replays', () => {
    const summary = describeDrive([replay('saved', 'ok')], [], [], undefined, [
      { status: 'passed' },
    ]);
    expect(summary.split('\n')[0]).toMatch(/^PROVED — 1 of 1 journey\(s\) passed/);
    expect(summary).toContain('Replayed 1 recorded journey(s)');
    expect(summary).not.toContain('Nothing was driven');
  });

  it('a plan whose journeys made no call still says how its journeys went, not "no action"', () => {
    const summary = describeDrive([], [], [], undefined, [{ status: 'failed' }]);
    expect(summary.split('\n')[0]).toMatch(/^NOT PROVED — 1 of 1 journey\(s\) failed/);
    expect(summary).not.toContain('Nothing was driven');
  });
});

describe('the values a drive typed', () => {
  it('are the fill and type values of its acts, steps included', () => {
    expect(
      typedValues([
        call('reticle_act', { ref: 'e1', action: 'fill', args: { value: 'Nina release 2' } }, {}),
        call('reticle_act_and_wait', { ref: 'e2', action: 'type', args: { text: 'hello' } }, {}),
        call(
          'reticle_act',
          { steps: [{ ref: 'e3', action: 'fill', args: { value: 'Fixed it' } }] },
          {},
        ),
        call('reticle_act', { ref: 'e4', action: 'click' }, {}),
      ]),
    ).toEqual(['Nina release 2', 'hello', 'Fixed it']);
  });
});

/*
 * Re-check: one Harness answer carried counts that disagreed — "1 of 1 check(s) held, 0
 * failed, 0 undecided" beside "6 action(s) were NOT PROVED", and "0 failed" beside "1 action(s)
 * FAILED … These are findings". Every count and every step line now reads the same graded checks.
 */
describe('one answer, one count', () => {
  const press = (verified: string) =>
    call(
      'reticle_act_and_wait',
      { ref: 'e336', action: 'click', until: { kind: 'net', method: 'POST' } },
      { verified, because: 'the declared consequence did not hold' },
    );

  it('never prints a re-press it graded undecided as a FAILED finding', () => {
    const summary = describeDrive([press('yes'), press('no')], []);
    expect(summary).toContain('1 of 2 check(s) held, 0 failed, 1 undecided');
    expect(summary).not.toContain('FAILED');
    expect(summary).not.toContain('findings');
    expect(summary).not.toMatch(/click e\d+: no\b/);
  });

  it('counts a check declared through `predicate`, the alias of `until`, as a check', () => {
    const aliased = call(
      'reticle_act_and_wait',
      { ref: 'e21', action: 'click', predicate: { kind: 'signal', name: 'nav' } },
      { verified: 'unknown', because: 'only the signal moved' },
    );
    expect(checkTally([acted('a', 'yes'), aliased])).toEqual({
      held: 1,
      failed: 0,
      undecided: 1,
    });
  });

  it('counts a check made through reticle_run as a check', () => {
    const wrapped = call(
      'reticle_run',
      {
        tool: 'reticle_act_and_wait',
        args: { ref: 'e2', action: 'click', until: { kind: 'signal', name: 'saved' } },
      },
      { verified: 'no', because: 'the declared consequence did not hold' },
    );
    expect(checkTally([wrapped])).toEqual({ held: 0, failed: 1, undecided: 0 });
  });

  it('states actions that declared nothing apart from the checks, never as undecided checks', () => {
    const quiet = call(
      'reticle_act_and_wait',
      { ref: 'e29', action: 'click' },
      { verified: 'no-fault', because: 'nothing was declared to prove' },
    );
    const summary = describeDrive([acted('a', 'yes'), quiet, quiet], []);
    expect(summary).toContain('1 of 1 check(s) held, 0 failed, 0 undecided');
    expect(summary).not.toMatch(/\d+ action\(s\) were NOT PROVED/);
    expect(summary).toContain('2 action(s) declared no consequence');
  });
});
