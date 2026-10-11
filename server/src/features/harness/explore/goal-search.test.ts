/**
 * The recorded Harness misses, replayed against a pretend app shaped like the one each persona drove.
 * Each test starts where the recorded drive ended and shows the hunt reaching the goal, or saying
 * honestly where it looked and did not find it.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { fakeApp } from './fake-app.js';
import { searchForGoal } from './goal-search.js';

const NAV = [
  '- complementary',
  '  - navigation "Main" (ref=e1)',
  '    - link "Issues" (ref=e2)',
  '    - link "Runs" (ref=e3)',
].join('\n');

describe('the hunt for a goal the drive did not end on', () => {
  /*
   * Persona 1: the drive clicked a tile through to /runs, then judged an Impact text there `no`; a
   * second drive found it below the fold and never scrolled. The map knows /overview shows it.
   */
  it('goes back to the page the map shows it on, and scrolls to it there', async () => {
    const app = fakeApp(
      {
        '/runs': { tree: `${NAV}\n- heading "Runs"` },
        '/overview': { tree: `${NAV}\n- heading "Impact"`, below: ['Things it did in your app'] },
      },
      '/runs',
    );
    const map = {
      surveyedAt: 0,
      pages: [
        { route: '/overview', texts: ['Impact', 'Things it did in your app'], controls: [], at: 0 },
      ],
    };
    const found = await searchForGoal(app.invoke, {
      goal: 'Things it did in your app',
      journey: 'Dana clicks the logo, keeps Mine, scrolls down to the counters',
      map,
    });
    expect(found).toMatchObject({ found: true, at: '/overview' });
    expect(found.searched).toEqual(['/runs', '/overview']);
    expect(app.route()).toBe('/overview');
    const scrolled = app.calls
      .filter(([n]) => ReticleTool.SCROLL_TO === n)
      .map(([, a]) => a['value']);
    expect(scrolled).toContain('Things it did in your app');
  });

  /* Persona 4: joined, opened Runs, stopped one click short of "Team". */
  it('presses the toggle beside the one that is on', async () => {
    const runs = (pressed: 'Mine' | 'Team', rows: string) =>
      [
        NAV,
        '- group "Whose work" (ref=e10)',
        `  - button "Mine" (ref=e11)${'Mine' === pressed ? ' [pressed]' : ''}`,
        `  - button "Team" (ref=e12)${'Team' === pressed ? ' [pressed]' : ''}`,
        rows,
      ].join('\n');
    const app = fakeApp(
      {
        '/runs': {
          tree: runs('Mine', '- text "No runs of yours yet"'),
          press: { e12: { to: '/runs?scope=team' } },
        },
        '/runs?scope=team': { tree: runs('Team', '- cell "acme-checkout"') },
      },
      '/runs',
    );
    const found = await searchForGoal(app.invoke, {
      goal: 'acme-checkout',
      journey: 'join Acme Corp F04, then open Runs and select Team to read the company runs',
    });
    expect(found).toMatchObject({ found: true, at: '/runs?scope=team' });
    expect(found.searched).toEqual(['/runs', '/runs: button "Team"', '/runs?scope=team']);
  });

  /*
   * Persona 7: searched "checkout defect", which no title contains, and never opened the issue. The
   * hunt undoes the search and reads the list; the issue's detail is a row it will not guess at, so
   * it says it did not find "Reopened by", and where it looked. Undecided, never `no`.
   */
  it('undoes a search that emptied the list, and is honest when the goal is behind a row', async () => {
    const app = fakeApp(
      {
        '/issues?q=checkout+defect': { tree: `${NAV}\n- heading "Nothing matches that filter"` },
        '/issues': {
          tree: `${NAV}\n- link "Check failed: an element matching" (ref=e30)\n- text "seen 3x"`,
        },
      },
      '/issues?q=checkout+defect',
    );
    const found = await searchForGoal(app.invoke, {
      goal: 'Reopened by',
      journey: 'Ana opens the issue Tom also hit and reads who reopened it',
    });
    expect(found.found).toBe(false);
    expect(found.searched).toEqual(['/issues?q=checkout+defect', '/issues']);
    expect(found.gaveUpAt).toBe('/issues');
  });

  /*
   * Persona 8: "must not show "payments"" is an absence (fix3's parser); the positive goal "Passed"
   * is hunted, and the absence is then graded on the page that shows it, not on a run it opened.
   */
  it('hunts the positive goal from an opened run back to the list it belongs on', async () => {
    const app = fakeApp(
      {
        '/runs/drive-1': { tree: `${NAV}\n- heading "Agent run"`, press: { e3: { to: '/runs' } } },
        '/runs': {
          tree: `${NAV}\n- group (ref=e10)\n  - button "Mine" (ref=e11) [pressed]\n  - button "Team" (ref=e12)\n- text "No runs of yours yet"`,
          press: { e12: { to: '/runs?scope=team' } },
        },
        '/runs?scope=team': { tree: `${NAV}\n- cell "Passed"\n- cell "marketing"` },
      },
      '/runs/drive-1',
    );
    const found = await searchForGoal(app.invoke, {
      goal: 'Passed',
      journey: 'Sam opens Runs, chooses Team, the list must not show "payments"',
    });
    expect(found).toMatchObject({ found: true, at: '/runs?scope=team' });
  });

  /*
   * Persona 10: opening the account menu was graded a wrong guess and the drive left the route its
   * plan named. A menu that opens is progress: the hunt follows the items the journey names.
   */
  it('opens the menu the journey names and follows its items to the goal', async () => {
    const overview = `${NAV}\n- button "Account: Leo Martin, Groupe Robotics · Pro" (ref=e40)\n- heading "Impact"`;
    const menu = `${overview}\n- menu (ref=e41)\n  - menuitem "Settings" (ref=e42)\n  - menuitem "Sign out" (ref=e43)`;
    const app = fakeApp(
      {
        '/overview': { tree: overview, press: { e40: { opens: menu }, e42: { to: '/settings' } } },
        '/settings': {
          tree: `${NAV}\n- heading "Settings"\n- link "Members and access" (ref=e50)`,
          press: { e50: { to: '/settings?group=members' } },
        },
        '/settings?group=members': { tree: `${NAV}\n- paragraph [text="3 of 3 seats used"]` },
      },
      '/overview',
    );
    const found = await searchForGoal(app.invoke, {
      goal: '3 of 3 seats used',
      journey:
        'Open Account: Leo Martin, Groupe Robotics · Pro, choose Settings, then Members and access; confirm "3 of 3 seats used"',
    });
    expect(found).toMatchObject({ found: true, at: '/settings?group=members' });
    // Never "Sign out", which the menu also offered.
    expect(app.calls.some(([, a]) => 'e43' === a['ref'])).toBe(false);
  });

  /* Persona 12: reached the goal page, walked past it to /runs; the map knows where it was. */
  it('finds a goal the drive walked past', async () => {
    const app = fakeApp(
      {
        '/runs?verdict=fail': { tree: `${NAV}\n- heading "Runs"` },
        '/overview?project=checkout&scope=team': {
          tree: `${NAV}\n- region "Runs that failed"\n  - text "Runs that failed 3 of 4 runs"`,
        },
      },
      '/runs?verdict=fail',
    );
    const map = {
      surveyedAt: 0,
      pages: [
        {
          route: '/overview?project=checkout&scope=team',
          texts: ['Runs that failed 3 of 4 runs'],
          controls: [],
          at: 0,
        },
      ],
    };
    const found = await searchForGoal(app.invoke, {
      goal: 'Runs that failed 3 of 4 runs',
      journey: 'Priya opens checkout and stays on that Impact page',
      map,
    });
    expect(found).toMatchObject({ found: true, at: '/overview?project=checkout&scope=team' });
  });

  it('stops within its budget and says where it gave up', async () => {
    const app = fakeApp(
      { '/': { tree: NAV, press: { e2: { to: '/issues' }, e3: { to: '/runs' } } } },
      '/',
    );
    const found = await searchForGoal(app.invoke, {
      goal: 'nowhere',
      journey: 'open Issues, then Runs',
      moves: 1,
    });
    expect(found.found).toBe(false);
    expect(app.calls.filter(([n]) => ReticleTool.ACT === n)).toHaveLength(1);
  });
});
