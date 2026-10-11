import { describe, expect, it } from 'vitest';
import { DisparityKind, Verified, type JournalAction } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
import { fakeApp } from '@/features/harness/explore/fake-app.js';
import { bestOfLanes, huntAndGrade } from './harness-hunt.js';

/** The agent's own tab: it asserted the goal and it held. */
const agentProved = (claim: string): JournalAction => ({
  v: 1,
  actionId: 'c1',
  tool: 'reticle_assert',
  args: {},
  effect: { claim, verified: Verified.YES },
  tRange: { from: 0, to: 1 },
  at: 1,
});

const deps = (actions: JournalAction[]): ToolDeps =>
  ({
    now: () => 1,
    sessions: {
      resolve: () => ({ id: 'harness-tab', projectId: 'web' }),
      all: () => [
        { id: 'agent-tab', projectId: 'web', readJournalActions: () => Promise.resolve(actions) },
        { id: 'other-app', projectId: 'api', readJournalActions: () => Promise.resolve(actions) },
      ],
    },
  }) as unknown as ToolDeps;

const NAV = '- navigation "Main" (ref=e1)\n  - link "Issues" (ref=e2)';

describe('grading a Harness drive after the hunt', () => {
  /*
   * Persona 7, end to end: the agent proved "Reopened by" on the issue; the Harness searched words no
   * title has. The goal is undecided with where it looked, and the run carries a discoverability
   * finding rather than a failed check on the app.
   */
  it('reports a goal the agent proved and the Harness could not find', async () => {
    const app = fakeApp(
      {
        '/issues?q=checkout+defect': { tree: `${NAV}\n- heading "Nothing matches that filter"` },
        '/issues': { tree: `${NAV}\n- link "Check failed: pay" (ref=e30)` },
      },
      '/issues?q=checkout+defect',
    );
    const graded = await huntAndGrade(
      deps([agentProved("text containing 'Reopened by'")]),
      app.invoke,
      {
        goals: ['Reopened by'],
        opening: '- heading "Impact"',
        journey: 'Ana opens the issue Tom also hit and reads who reopened it',
      },
    );
    expect(graded.goals[0]).toMatchObject({ text: 'Reopened by', verified: Verified.UNKNOWN });
    expect(graded.goals[0]?.reason).toContain(
      'not found after searching /issues?q=checkout+defect → /issues',
    );
    expect(graded.disparity).toEqual([
      expect.objectContaining({ kind: DisparityKind.DISCOVERABILITY, goal: 'Reopened by' }),
    ]);
    expect(app.calls.some(([name]) => 'reticle_assert' === name)).toBe(false);
  });

  /* Persona 1, end to end: found where the map says, graded `yes` there, and findable both ways. */
  it('grades where the hunt found the goal', async () => {
    const app = fakeApp(
      {
        '/runs': { tree: `${NAV}\n- heading "Runs"` },
        '/overview': { tree: `${NAV}\n- heading "Impact"`, below: ['Things it did in your app'] },
      },
      '/runs',
    );
    const graded = await huntAndGrade(
      deps([agentProved("text containing 'Things it did in your app'")]),
      app.invoke,
      {
        goals: ['Things it did in your app'],
        opening: '- heading "Home"',
        journey: 'Dana keeps Mine and scrolls down',
        map: {
          surveyedAt: 0,
          pages: [
            { route: '/overview', texts: ['Things it did in your app'], controls: [], at: 0 },
          ],
        },
      },
    );
    expect(graded.goals).toEqual([{ text: 'Things it did in your app', verified: Verified.YES }]);
    expect(graded.disparity[0]?.kind).toBe(DisparityKind.FINDABLE);
  });
});

/*
 * From a persona drive: the third lane proved the end text, and the run read NOT PROVED because the goal
 * was graded on the caller's tab, still on /login. A goal is graded where a lane reached it.
 */
describe('a plan run in several lanes', () => {
  it('takes, per goal, the lane that proved it', () => {
    const lane = (verified: Verified) => ({
      goals: [{ text: 'acme-checkout', verified }],
      disparity: [],
    });
    expect(
      bestOfLanes([lane(Verified.UNKNOWN), lane(Verified.NO), lane(Verified.YES)]).goals,
    ).toEqual([{ text: 'acme-checkout', verified: Verified.YES }]);
    expect(bestOfLanes([lane(Verified.UNKNOWN), lane(Verified.NO)]).goals[0]?.verified).toBe(
      Verified.NO,
    );
  });
});
