import { describe, expect, it } from 'vitest';
import { asRecord, ReticleTool } from '@reticlehq/core';
import {
  checkExpect,
  checkGoals,
  endGoalsOf,
  goalOfDrive,
  goalsIn,
  goalsMet,
  lookFor,
  parseGoals,
  unprovedGoals,
  writtenByHarness,
} from './goals.js';

describe('the goals a drive was asked to prove (#1316)', () => {
  it('are the strings the persona quoted', () => {
    expect(
      goalsIn('check that "Ada Lovelace" and “Grace Hopper” are listed, don\'t delete'),
    ).toEqual(['Ada Lovelace', 'Grace Hopper']);
    expect(goalsIn('click around')).toEqual([]);
    expect(goalsIn(undefined)).toEqual([]);
  });

  // A persona quoting an issue title with quotes in it got three goals: `{`, `:` and `}`.
  it('keeps a quoted goal whole when it has quotes inside it', () => {
    expect(
      goalsIn('open the issue "Check failed: an element matching {"testid":"pay"}" and read it'),
    ).toEqual(['Check failed: an element matching {"testid":"pay"}']);
  });

  // "must not show "payments"" was graded as a goal to show payments, so isolation was unprovable.
  it('reads a negated quote as text that must be absent', () => {
    expect(
      parseGoals(
        'the list must name marketing and must not show "payments", ending when the page shows "Passed"',
      ),
    ).toEqual([{ text: 'payments', absent: true }, { text: 'Passed' }]);
    expect(parseGoals('it doesn\'t show "Draft" until you click "Publish"')).toEqual([
      { text: 'Draft', absent: true },
      { text: 'Publish' },
    ]);
    expect(goalsIn('must not show "payments", ending on "Passed"')).toEqual(['Passed']);
    expect(
      parseGoals(
        'place the order without the coupon, ending when the page shows "Order confirmed"',
      ),
    ).toEqual([{ text: 'Order confirmed' }]);
  });

  /** A page whose snapshot reads `tree`; `below` holds text only a scroll brings into the tree. */
  const page = (tree: string, assertSays: string, below: readonly string[] = []) => {
    const asked: [string, Record<string, unknown>][] = [];
    const invoke = (name: string, args: Record<string, unknown>): Promise<unknown> => {
      asked.push([name, args]);
      if (ReticleTool.SNAPSHOT === name) return Promise.resolve({ tree });
      if (ReticleTool.SCROLL_TO === name) {
        const value = String(args['value']);
        return Promise.resolve({ found: tree.includes(value) || below.includes(value) });
      }
      if (ReticleTool.WAIT_FOR === name) return Promise.resolve({ pass: true });
      return Promise.resolve({ verified: assertSays });
    };
    return { asked, invoke };
  };
  const asserts = (asked: [string, Record<string, unknown>][]) =>
    asked.filter(([name]) => ReticleTool.ASSERT === name).map(([, args]) => args['predicate']);

  it('records one assert over the quotes the page shows, and leaves the rest undecided', async () => {
    const p = page('heading "Ada Lovelace"', 'yes');
    const checks = await checkGoals(p.invoke, ['Ada Lovelace', 'Grace Hopper']);
    expect(asserts(p.asked)).toEqual([{ kind: 'text', contains: 'Ada Lovelace' }]);
    expect(checks.map((c) => [c.text, c.verified])).toEqual([
      ['Ada Lovelace', 'yes'],
      ['Grace Hopper', 'unknown'],
    ]);
    expect(unprovedGoals(checks)).toContain('"Grace Hopper" (inconclusive: not on the page');
  });

  /*
   * A drive that clicked through to /runs was graded `no` on an /overview text, and one that never
   * opened the issue was graded `no` on the issue's "Reopened by": both blamed the app for where
   * the Harness stopped. A goal the end page does not show, even scrolled, is undecided.
   */
  it('records no failed check when the page the drive ended on shows none of them', async () => {
    const p = page('heading "Dashboard"', 'no');
    const checks = await checkGoals(p.invoke, ['Ada Lovelace', 'Grace Hopper']);
    expect(asserts(p.asked)).toEqual([]);
    expect(checks.map((c) => c.verified)).toEqual(['unknown', 'unknown']);
  });

  // "Reopened by" sat at y≈811 and came back `unknown` on a drive that never scrolled.
  it('lets the page settle, then scrolls each goal into view by its text before judging', async () => {
    const p = page('heading "Issue"', 'yes', ['Reopened by Tom']);
    const checks = await checkGoals(p.invoke, ['Reopened by Tom']);
    expect(p.asked.map(([name]) => name)).toEqual([
      ReticleTool.WAIT_FOR,
      ReticleTool.SNAPSHOT,
      ReticleTool.SCROLL_TO,
      ReticleTool.ASSERT,
    ]);
    expect(p.asked[2]?.[1]).toMatchObject({ by: 'text', value: 'Reopened by Tom' });
    expect(checks).toEqual([{ text: 'Reopened by Tom', verified: 'yes' }]);
  });

  /*
   * From a re-drive: the Harness typed "Nina release 2", pressed Generate, and the page showed the end
   * text; one allOf over all three goals came back "no" (a typed value is a field's value, which a
   * text check does not read), and every goal was graded "no" beside a page that showed them.
   */
  it('grades each goal on its own when the joint check fails, and a shown one is never "no"', async () => {
    const tree = 'textbox "Name": Nina release 2\nheading "Generated script for: Fixed it"';
    const asked: Record<string, unknown>[] = [];
    const invoke = (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (ReticleTool.SNAPSHOT === name) return Promise.resolve({ tree });
      if (ReticleTool.SCROLL_TO === name)
        return Promise.resolve({ found: tree.includes(String(args['value'])) });
      if (ReticleTool.ASSERT !== name) return Promise.resolve({ pass: true });
      asked.push(asRecord(args['predicate']));
      const contains = asRecord(args['predicate'])['contains'];
      return Promise.resolve({
        verified: 'Generated script for: Fixed it' === contains ? 'yes' : 'no',
      });
    };
    const checks = await checkGoals(invoke, ['Nina release 2', 'Generated script for: Fixed it']);
    expect(checks.map((c) => [c.text, c.verified])).toEqual([
      ['Nina release 2', 'unknown'],
      ['Generated script for: Fixed it', 'yes'],
    ]);
    expect(checks[0]?.reason).toMatch(/shown on the page/);
  });

  it('asserts an absence goal as text that is not there', async () => {
    const p = page('heading "Runs" cell "Passed"', 'yes');
    const checks = await checkGoals(p.invoke, [{ text: 'payments', absent: true }, 'Passed']);
    expect(asserts(p.asked)).toEqual([
      {
        kind: 'allOf',
        predicates: [
          { kind: 'text', contains: 'Passed' },
          { kind: 'not', predicate: { kind: 'text', contains: 'payments' } },
        ],
      },
    ]);
    expect(checks).toEqual([
      { text: 'payments', absent: true, verified: 'yes' },
      { text: 'Passed', verified: 'yes' },
    ]);
  });

  it('leaves an absence undecided when the drive never reached the page it ends on', async () => {
    const p = page('heading "Home"', 'yes');
    const checks = await checkGoals(p.invoke, [{ text: 'payments', absent: true }, 'Passed']);
    expect(asserts(p.asked)).toEqual([]);
    expect(checks.map((c) => c.verified)).toEqual(['unknown', 'unknown']);
  });

  it('never records a "no" for the start state a working app replaced', async () => {
    // "goes from "Count is 0" to "Count is 1"": one assert, on the end state, and it held.
    const p = page('button "Count is 1"', 'yes');
    await checkGoals(p.invoke, ['Count is 0', 'Count is 1']);
    expect(asserts(p.asked)).toEqual([{ kind: 'text', contains: 'Count is 1' }]);
  });

  /*
   * A Harness drive asked to "check the page shows "Compose"" synced as Passed: "Compose" was a
   * sidebar label on the page before the drive did anything, so asserting it at the end held and
   * proved nothing. A goal the opening page already showed is not checked and is not proved.
   */
  it('never checks a goal the page showed before the drive started, and never calls it proved', async () => {
    const p = page('button "Compose"', 'yes');
    const checks = await checkGoals(p.invoke, ['Compose'], 'link "Compose" heading "Deployments"');
    expect(asserts(p.asked)).toEqual([]);
    expect(checks).toEqual([
      {
        text: 'Compose',
        verified: 'unknown',
        reason:
          'already_true: it was on the page before the drive started, so seeing it proves nothing',
      },
    ]);
    expect(unprovedGoals(checks)).toContain(
      '"Compose" (already_true: it was on the page before the drive started',
    );
  });

  it('still checks the goals the opening page did not show', async () => {
    const p = page('heading "Saved" button "Compose"', 'yes');
    const checks = await checkGoals(p.invoke, ['Compose', 'Saved'], 'link "Compose"');
    expect(asserts(p.asked)).toEqual([{ kind: 'text', contains: 'Saved' }]);
    expect(checks.map((c) => [c.text, c.verified])).toEqual([
      ['Compose', 'unknown'],
      ['Saved', 'yes'],
    ]);
  });

  it('counts a check that could not run as not proved', async () => {
    const checks = await checkGoals(() => Promise.reject(new Error('tab gone')), ['Ada']);
    expect(checks.map((c) => [c.text, c.verified])).toEqual([['Ada', 'unknown']]);
    expect(unprovedGoals([{ text: 'Ada', verified: 'yes' }])).toBeUndefined();
  });
});

/*
 * A Harness drive asked to rename a plan made two clicks, reached the /plans list and was graded
 * PROVED on all three quoted goals: the plan it had just saved was named after the journey, and
 * that name, listed on /plans, held every quote. Text the Harness wrote proves nothing about the app.
 */
describe('a goal shown only in text the Harness wrote itself', () => {
  const journey =
    'Go to Flows, open the Plans tab, open Checkout regression, change its name to Checkout ' +
    'regression v2, and save. End when the page shows "Saved. The next run tests the plan as it is now."';
  const goals = [
    'Checkout regression',
    'Checkout regression v2',
    'Saved. The next run tests the plan as it is now.',
  ];
  /** The /plans list as the snapshot reads it: the saved plan's name, cut at 80 characters. */
  const row = `${journey.slice(0, 80)}…`;
  const app = (tree: string, found: string) => {
    const asked: [string, Record<string, unknown>][] = [];
    const invoke = (name: string, args: Record<string, unknown>): Promise<unknown> => {
      asked.push([name, args]);
      if (ReticleTool.SNAPSHOT === name) return Promise.resolve({ tree });
      // The browser's text search lands on the row too, and hands back its cut text.
      if (ReticleTool.SCROLL_TO === name)
        return Promise.resolve({ found: true, element: { text: found } });
      if (ReticleTool.WAIT_FOR === name) return Promise.resolve({ pass: true });
      return Promise.resolve({ verified: 'yes' });
    };
    return { asked, invoke };
  };

  it('is never proved by the name of the plan the Harness saved', async () => {
    const p = app(`- heading "Harness plans"\n- link "${row}" (ref=e1)`, row);
    const checks = await checkGoals(p.invoke, goals, undefined, [journey]);
    expect(p.asked.filter(([name]) => ReticleTool.ASSERT === name)).toEqual([]);
    expect(checks.map((c) => c.verified)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(await lookFor(p.invoke, goals[2] ?? '', [journey])).toBe(false);
  });

  it('is still proved where the app shows it itself', async () => {
    const status = 'Saved. The next run tests the plan as it is now.';
    const p = app(`- link "${row}" (ref=e1)\n- status "${status}"`, status);
    const checks = await checkGoals(p.invoke, [status], undefined, [journey]);
    expect(checks).toEqual([{ text: status, verified: 'yes' }]);
  });

  it('tells a name the Harness wrote from an app text that only contains a goal', () => {
    expect(writtenByHarness(row, 'Checkout regression', [journey])).toBe(true);
    expect(writtenByHarness(`${journey} and 5 more`, 'Checkout regression', [journey])).toBe(true);
    expect(writtenByHarness('Checkout regression', 'Checkout regression', [journey])).toBe(false);
    expect(writtenByHarness('Checkout regression v2', 'Checkout regression', [journey])).toBe(
      false,
    );
    expect(writtenByHarness(row, 'Checkout regression', [])).toBe(false);
  });
});

describe('an outcome the journey must end in', () => {
  const route = { kind: 'route', path: '/orders/confirmed' };

  it('is asserted as given and graded by the engine', async () => {
    const asked: [string, Record<string, unknown>][] = [];
    const check = await checkExpect((name, args) => {
      asked.push([name, args]);
      return Promise.resolve({ verified: 'no' });
    }, route);
    expect(asked).toEqual([[ReticleTool.ASSERT, { predicate: route }]]);
    expect(check.verified).toBe('no');
    expect(check.text).toContain('/orders/confirmed');
    expect(unprovedGoals([check])).toContain('/orders/confirmed');
  });

  it('is unknown, never a pass, when the assert cannot run', async () => {
    const check = await checkExpect(() => Promise.reject(new Error('gone')), route);
    expect(check.verified).toBe('unknown');
  });
});

/*
 * A drive whose one click held synced as Passed while the goal it was given ("check the page shows
 * "Compose"") was not proved. The goals decide whether the journey was done; a held click does not.
 */
describe('whether the drive met the goals it was given', () => {
  it('says nothing when it was given none', () => {
    expect(goalsMet([])).toBeUndefined();
  });
  it('is met only when every goal was proved', () => {
    expect(goalsMet([{ text: 'Saved', verified: 'yes' }])).toBe(true);
    expect(
      goalsMet([
        { text: 'Saved', verified: 'yes' },
        { text: 'Compose', verified: 'unknown' },
      ]),
    ).toBe(false);
    expect(goalsMet([{ text: 'Saved', verified: 'no' }])).toBe(false);
  });
});

/*
 * A run answered `goalMet: true` with zero actions on a tab that already showed the end state, and
 * another with both of its goals `unknown`: the driver's word was reported as the result.
 */
describe('the goal verdict a drive reports', () => {
  const yes = { text: 'Saved', verified: 'yes' };
  const already = { text: 'Passed', verified: 'unknown', reason: 'already_true: …' };

  it('is never met without an action that ran, whatever the driver said', () => {
    expect(goalOfDrive(true, [], false)).toBe(false);
  });

  it('is decided by the goals, not the driver, when there are goals', () => {
    expect(goalOfDrive(true, [already], true)).toBe(false);
    expect(goalOfDrive(undefined, [yes], true)).toBe(true);
  });

  /*
   * Persona 22: the plan rewrote the end text, so the driver's own end check failed and it said it
   * missed; the Harness then found the persona's own words and proved them `yes`. A goal the run
   * proved is met, whatever the driver said and whether the drive or the hunt reached it.
   */
  it('is met when the run proved every goal, whatever the driver said', () => {
    expect(goalOfDrive(false, [yes], true)).toBe(true);
    expect(goalOfDrive(true, [yes], false)).toBe(true);
  });

  it("keeps the driver's word with no goals, and says nothing when nothing judged it", () => {
    expect(goalOfDrive(true, [], true)).toBe(true);
    expect(goalOfDrive(undefined, [], true)).toBeUndefined();
    expect(goalOfDrive(undefined, [], false)).toBeUndefined();
  });
});

/*
 * A re-drive graded "Nina release 2" and "Fixed the login timeout" (values the drive TYPED) as goals,
 * "no", beside an end text the page showed. A value the drive typed is an input; only the journey's
 * end (its last quote) is graded even when it was typed, because saving "Order 7" and then seeing
 * "Order 7" in the list is exactly the journey.
 */
describe('the goals a drive is graded on', () => {
  it('leaves out a quoted value the drive typed, but never the end', () => {
    expect(
      endGoalsOf(
        [
          { text: 'Nina release 2' },
          { text: 'Fixed the login timeout' },
          { text: 'Generated script' },
        ],
        ['Nina release 2', 'Fixed the login timeout'],
      ),
    ).toEqual([{ text: 'Generated script' }]);
    expect(endGoalsOf([{ text: 'Order 7' }], ['Order 7'])).toEqual([{ text: 'Order 7' }]);
    expect(
      endGoalsOf([{ text: 'payments', absent: true }, { text: 'Passed' }], ['payments']),
    ).toEqual([{ text: 'payments', absent: true }, { text: 'Passed' }]);
  });
});
