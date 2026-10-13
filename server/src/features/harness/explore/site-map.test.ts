import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { fakeApp } from './fake-app.js';
import { CONSOLE_FLOWS, CONSOLE_OVERVIEW, CONSOLE_SWITCHER_OPEN } from './console-pages.js';
import { mergePages, pagesReadIn, parseMap, surveyApp, surveyedSince } from './site-map.js';

const OVERVIEW = [
  '- complementary',
  '  - navigation "Main" (ref=e1)',
  '    - link "Issues" (ref=e2)',
  '    - link "Runs" (ref=e3)',
  '  - button "Sign out" (ref=e4)',
  '- heading "Impact" (ref=e5)',
  '- group "Whose work" (ref=e6)',
  '  - button "Mine" (ref=e7) [pressed]',
  '  - button "Team" (ref=e8)',
  '- paragraph [text="Things it did in your app"]',
  '- button "Delete project" (ref=e9)',
].join('\n');

describe('the survey before a drive', () => {
  const app = () =>
    fakeApp(
      {
        '/overview': {
          tree: OVERVIEW,
          press: {
            e2: { to: '/issues' },
            e3: { to: '/runs' },
            e8: { to: '/overview?scope=team' },
          },
        },
        '/issues': { tree: '- heading "Issues" (ref=e1)\n- text "No open issues"' },
        '/runs': { tree: '- heading "Runs" (ref=e1)\n- cell "acme-checkout"' },
        '/overview?scope=team': { tree: '- heading "Impact" (ref=e1)\n- text "1 of 1 members"' },
      },
      '/overview',
    );

  it('reads each nav link and toggle once, and records what each page shows', async () => {
    const fake = app();
    const map = await surveyApp(fake.invoke, () => 7);
    const routes = map?.pages.map((p) => p.route).sort();
    expect(routes).toEqual(['/issues', '/overview', '/overview?scope=team', '/runs']);
    const overview = map?.pages.find((p) => '/overview' === p.route);
    expect(overview?.heading).toBe('Impact');
    expect(overview?.texts).toContain('Things it did in your app');
    expect(map?.pages.find((p) => '/runs' === p.route)?.reachedBy).toBe('link "Runs"');
  });

  it('never presses a write or a sign-out, and leaves the tab where it started', async () => {
    const fake = app();
    await surveyApp(fake.invoke, () => 7);
    const pressed = fake.calls.filter(([n]) => ReticleTool.ACT === n).map(([, a]) => a['ref']);
    expect(pressed).toEqual(['e2', 'e3', 'e8']);
    expect(fake.route()).toBe('/overview');
  });

  it('spends no more presses than it is given', async () => {
    const fake = app();
    await surveyApp(fake.invoke, () => 7, 1);
    expect(fake.calls.filter(([n]) => ReticleTool.ACT === n)).toHaveLength(1);
  });
});

describe('the map kept between drives', () => {
  const page = (route: string, at: number, texts: string[] = []) => ({
    route,
    texts,
    controls: [],
    at,
  });

  it('takes the newest read of a page, and keeps how the survey reached it', () => {
    const map = {
      surveyedAt: 1,
      pages: [{ ...page('/runs', 1, ['old']), reachedBy: 'link "Runs"' }],
    };
    const merged = mergePages(map, [page('/runs', 5, ['new']), page('/issues', 5)]);
    expect(merged.surveyedAt).toBe(1);
    expect(merged.pages.find((p) => '/runs' === p.route)).toMatchObject({
      texts: ['new'],
      reachedBy: 'link "Runs"',
    });
  });

  it('is refreshed from the pages a drive read', () => {
    const pages = pagesReadIn(
      [
        {
          id: '1',
          name: ReticleTool.SNAPSHOT,
          args: { mode: 'full' },
          result: { tree: '- heading "Team"', status: { route: '/runs?__reticle_session=x' } },
          isError: false,
        },
      ],
      9,
    );
    expect(pages).toEqual([
      { route: '/runs', heading: 'Team', texts: ['Team'], controls: [], at: 9 },
    ]);
  });

  it('reads back only a map that parses', () => {
    expect(parseMap(undefined)).toBeUndefined();
    expect(parseMap('{"pages": 3}')).toBeUndefined();
    expect(parseMap(JSON.stringify({ surveyedAt: 1, pages: [] }))).toEqual({
      surveyedAt: 1,
      pages: [],
    });
  });
});

/*
 * Persona 21, live: the kept map was one page, /overview, read with the workspace switcher open; a
 * drive's menu-open read had replaced the survey's. The survey closes what is open before it reads,
 * and a drive's reads refresh the map only when they are full reads of an unobstructed page.
 */
describe('the map of the real console', () => {
  it('records Flows with its Memory link, though a menu was open when the survey began', async () => {
    const fakeWithMenu = fakeApp(
      {
        '/overview': {
          tree: CONSOLE_OVERVIEW,
          press: { e102: { to: '/flows' }, e107: { opens: CONSOLE_SWITCHER_OPEN } },
        },
        '/flows': { tree: CONSOLE_FLOWS },
      },
      '/overview',
    );
    await fakeWithMenu.invoke(ReticleTool.ACT, { ref: 'e107', action: 'click' });
    const map = await surveyApp(fakeWithMenu.invoke, () => 7);
    const flows = map?.pages.find((p) => '/flows' === p.route);
    expect(flows?.controls).toContain('link "Memory"');
    expect(map?.pages.find((p) => '/overview' === p.route)?.texts).toContain(
      'What Reticle did for your team',
    );
    expect(fakeWithMenu.route()).toBe('/overview');
  });

  it('is not refreshed from a quick read or a page a menu covers', () => {
    const call = (mode: string, tree: string) => ({
      id: '1',
      name: ReticleTool.SNAPSHOT,
      args: { mode },
      result: { tree, status: { route: '/overview' } },
      isError: false,
    });
    expect(pagesReadIn([call('interactive', CONSOLE_OVERVIEW)], 9)).toEqual([]);
    expect(pagesReadIn([call('full', CONSOLE_SWITCHER_OPEN)], 9)).toEqual([]);
    expect(pagesReadIn([call('full', CONSOLE_OVERVIEW)], 9)).toHaveLength(1);
  });
});

/**
 * Every plan run clicked through the whole app after its journeys, map fresh or not. The sweep
 * runs when the app was surveyed for this run, and a run on a fresh map leaves the app alone.
 */
describe('whether a run sweeps the app', () => {
  it('sweeps when this run surveyed it, and not when a fresh map was reused', () => {
    const startedAt = 5_000;
    expect(surveyedSince({ surveyedAt: 5_200, pages: [] }, startedAt)).toBe(true);
    expect(surveyedSince({ surveyedAt: 1_000, pages: [] }, startedAt)).toBe(false);
    expect(surveyedSince(undefined, startedAt)).toBe(true);
  });
});
