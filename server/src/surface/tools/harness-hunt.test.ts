import { join } from 'node:path';
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

  /* Persona 22: the hunt's own navigations are the Harness driving the app, and are kept to say so. */
  it('keeps the navigations and clicks the hunt made, and nothing that checks', async () => {
    const app = fakeApp(
      {
        '/issues?q=checkout+defect': { tree: `${NAV}\n- heading "Nothing matches that filter"` },
        '/issues': { tree: `${NAV}\n- link "Check failed: pay" (ref=e30)` },
      },
      '/issues?q=checkout+defect',
    );
    const graded = await huntAndGrade(deps([]), app.invoke, {
      goals: ['Reopened by'],
      opening: '- heading "Impact"',
      journey: 'Ana opens the issue Tom also hit and reads who reopened it',
    });
    expect(graded.moved.length).toBeGreaterThan(0);
    expect(
      graded.moved.every((c) => 'reticle_navigate' === c.name || 'reticle_act' === c.name),
    ).toBe(true);
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
      moved: [],
    });
    expect(
      bestOfLanes([lane(Verified.UNKNOWN), lane(Verified.NO), lane(Verified.YES)]).goals,
    ).toEqual([{ text: 'acme-checkout', verified: Verified.YES }]);
    expect(bestOfLanes([lane(Verified.UNKNOWN), lane(Verified.NO)]).goals[0]?.verified).toBe(
      Verified.NO,
    );
  });
});

/*
 * Persona 21, live: Memory was two clicks from where the drive stopped, the agent had proved both
 * goals on a tab that had since closed, and the hunt gave up on the page it started on.
 */
describe('the live persona 21 miss', () => {
  const NAV21 = '- complementary\n  - navigation "Main" (ref=e97)\n    - link "Flows" (ref=e102)';
  const journalOf = (claim: string): string =>
    `${JSON.stringify({
      v: 1,
      actionId: 'c1',
      tool: 'reticle_assert',
      args: {},
      effect: { claim, verified: Verified.YES },
      tRange: { from: 0, to: 1 },
      at: 1,
    })}\n`;

  it('reaches Memory through Flows, grades the goal it can find there, and compares with a closed tab', async () => {
    const app = fakeApp(
      {
        '/overview': { tree: `${NAV21}\n- heading "Impact"`, press: { e102: { to: '/flows' } } },
        '/flows': {
          tree: '- main\n  - navigation "Flows" (ref=e144)\n    - link "Memory" (ref=e150)',
          press: { e150: { to: '/memory' } },
        },
        '/memory': { tree: '- heading "Memory"\n- button "Free shipping threshold" (ref=e162)' },
      },
      '/overview',
    );
    // Keyed the way the hunt builds them (`path.join`), so Windows' separators match too.
    const sessionsDir = join('/p/.reticle', 'sessions');
    const files: Record<string, string> = {
      [join(sessionsDir, 'lease-closed', 'actions.jsonl')]: journalOf(
        "text containing 'Free shipping threshold'",
      ),
    };
    const deps = {
      now: () => 1,
      reticleRoot: '/p/.reticle',
      fs: {
        readdir: (dir: string) => Promise.resolve(sessionsDir === dir ? ['lease-closed'] : []),
        readFile: (path: string) =>
          files[path] === undefined
            ? Promise.reject(new Error('ENOENT'))
            : Promise.resolve(files[path]),
        exists: (path: string) => Promise.resolve(files[path] !== undefined),
      },
      sessions: {
        resolve: () => ({ id: 'harness-tab', projectId: 'web', artifactRoot: '/p/.reticle' }),
        all: () => [],
      },
    } as unknown as ToolDeps;
    const graded = await huntAndGrade(deps, app.invoke, {
      goals: ['Free shipping threshold', 'chose to keep these words'],
      opening: '- heading "Impact"',
      journey: 'Bea opens Memory and keeps the words the team agreed on',
      map: {
        surveyedAt: 0,
        pages: [{ route: '/flows', texts: [], controls: ['link "Memory"'], at: 0 }],
      },
    });
    expect(app.route()).toBe('/memory');
    expect(graded.goals[0]).toEqual({ text: 'Free shipping threshold', verified: Verified.YES });
    expect(graded.goals[1]?.reason).toContain('/flows: link "Memory"');
    expect(graded.disparity).toEqual([
      expect.objectContaining({ goal: 'Free shipping threshold', kind: DisparityKind.FINDABLE }),
    ]);
  });
});
