/**
 * The App Map is built from what the run recorded, never from what the model said: screens from route
 * changes, actions from what each act pressed (anchored as a flow anchors it), requests and the things
 * a write made from the act's own window. Ids collapse, so a hundred conversations are one screen.
 */
import { describe, expect, it } from 'vitest';
import { EventType } from '@/wire/constants/event-types.js';
import type { ReticleEvent } from '@/wire/messages.js';
import {
  MapEdgeKind,
  MapNodeKind,
  controlsOf,
  frontierLine,
  pathTo,
  mapLine,
  mapOfRun,
  mergeMap,
  type DrivenStep,
} from './app-graph.js';

const ev = (type: string, data: Record<string, unknown>, t: number): ReticleEvent =>
  ({ type, t, data }) as unknown as ReticleEvent;
const route = (pathname: string, t: number) =>
  ev(EventType.ROUTE_CHANGE, { pathname, to: pathname }, t);
const request = (method: string, url: string, status: number, t: number) =>
  ev(EventType.NET_REQUEST, { method, url, status, initiator: 'fetch' }, t);

const step = (
  anchor: Record<string, unknown>,
  since: number,
  window: ReticleEvent[],
): DrivenStep => ({
  anchor,
  since,
  window,
});

// A drive: lands on /flows, makes a project, opens a conversation.
const events = [
  route('/flows', 1),
  request('POST', 'http://localhost:8896/v1/projects', 201, 12),
  route('/chat/chat_659b61951bdf4e7d86670a75750421a4', 22),
  request(
    'GET',
    'http://localhost:8896/v1/chat/conversations/chat_659b61951bdf4e7d86670a75750421a4',
    200,
    23,
  ),
];
const steps = [
  step({ by: 'testid', value: 'project-create', action: 'click' }, 10, events.slice(1, 2)),
  step({ by: 'role', value: 'link', name: 'Chat', action: 'click' }, 20, events.slice(2, 4)),
];

describe('the map of one run', () => {
  const run = mapOfRun(steps, events, '/');

  it('has the screens the run was on, ids collapsed', () => {
    const screens = [...run.nodes.values()]
      .filter((n) => MapNodeKind.SCREEN === n.kind)
      .map((n) => n.label);
    expect(screens.sort()).toEqual(['/', '/chat/:id', '/flows']);
  });

  it('leaves background reads off an action: a read the app also sent with nothing pressed', () => {
    const poll = (t: number) => request('GET', 'http://localhost:8896/v1/inbox/unread', 200, t);
    const all = [
      route('/flows', 1),
      poll(5),
      request('POST', 'http://localhost:8896/v1/projects', 201, 12),
      poll(13),
      poll(30),
    ];
    const ran = mapOfRun(
      [step({ by: 'testid', value: 'project-create', action: 'click' }, 10, all.slice(2, 4))],
      all,
      '/',
    );
    const sent = [...ran.edges.values()]
      .filter((e) => MapEdgeKind.SENDS === e.kind)
      .map((e) => e.to);
    expect(sent).toEqual(['request POST /v1/projects']);
  });

  it('names what a write made by the type its answer carries, so a GraphQL write is not "graphql"', () => {
    const made = ev(
      EventType.NET_REQUEST,
      {
        method: 'POST',
        url: 'http://localhost:4000/graphql',
        status: 200,
        initiator: 'fetch',
        responseBody: '{"data":{"createProject":{"__typename":"Project","id":"p1"}}}',
      },
      12,
    );
    const ran = mapOfRun(
      [step({ by: 'testid', value: 'create', action: 'click' }, 10, [made])],
      [made],
      '/',
    );
    const things = [...ran.nodes.values()].filter((n) => MapNodeKind.THING === n.kind);
    expect(things.map((n) => n.label)).toEqual(['Project']);
  });

  it('puts what a look saw on the screen its route change named, not a second guess at the address', () => {
    const named = [
      ev(
        EventType.ROUTE_CHANGE,
        { pathname: '/issues/web-checkout', pattern: '/issues/:fingerprint' },
        1,
      ),
    ];
    const ran = mapOfRun([], named, undefined, [
      { screen: '/issues/web-checkout', controls: [{ role: 'button', name: 'Assign' }] },
    ]);
    const screens = [...ran.nodes.values()].filter((n) => MapNodeKind.SCREEN === n.kind);
    expect(screens.map((n) => n.label)).toEqual(['/issues/:fingerprint']);
  });

  it('names what a REST write made by the type its answer declares, else by its path', () => {
    const write = (url: string, responseBody: string, t: number) =>
      ev(
        EventType.NET_REQUEST,
        { method: 'POST', url, status: 201, initiator: 'fetch', responseBody },
        t,
      );
    const made = [
      write('http://api.test/v1/c', '{"object":"customer","id":"cus_1"}', 11),
      write('http://api.test/v1/x', '{"data":{"type":"articles","id":"1"}}', 12),
      write('http://api.test/v1/orders', '{"id":"o1"}', 13),
    ];
    const ran = mapOfRun(
      [step({ by: 'testid', value: 'go', action: 'click' }, 10, made)],
      made,
      '/',
    );
    const things = [...ran.nodes.values()].filter((n) => MapNodeKind.THING === n.kind);
    expect(things.map((n) => n.label).sort()).toEqual(['articles', 'customer', 'orders']);
  });

  it('puts each action on the screen it was pressed on', () => {
    expect([...run.edges.values()]).toContainEqual({
      from: 'screen /flows',
      to: 'action /flows testid=project-create',
      kind: MapEdgeKind.HAS,
    });
  });

  it('links what an action led to, sent, and made', () => {
    const edges = [...run.edges.values()];
    expect(edges).toContainEqual({
      from: 'action /flows testid=project-create',
      to: 'request POST /v1/projects',
      kind: MapEdgeKind.SENDS,
    });
    expect(edges).toContainEqual({
      from: 'action /flows testid=project-create',
      to: 'thing projects',
      kind: MapEdgeKind.MAKES,
    });
    expect(edges).toContainEqual({
      from: 'action /flows link "Chat"',
      to: 'screen /chat/:id',
      kind: MapEdgeKind.LEADS_TO,
    });
  });
});

describe('the map across runs', () => {
  it('counts what each run saw, and grows with what a run found new', () => {
    const once = mergeMap(undefined, mapOfRun(steps, events, '/'), 'r1');
    const twice = mergeMap(once, mapOfRun(steps.slice(0, 1), events.slice(0, 2), '/'), 'r2');
    expect(twice.nodes.find((n) => 'screen /flows' === n.id)).toMatchObject({
      seen: 2,
      lastRun: 'r2',
    });
    expect(twice.nodes.find((n) => 'screen /chat/:id' === n.id)).toMatchObject({
      seen: 1,
      lastRun: 'r1',
    });
  });

  it('says what it knows in one line', () => {
    const map = mergeMap(undefined, mapOfRun(steps, events, '/'), 'r1');
    expect(mapLine(map)).toBe(
      'The map so far: 3 screens, 2 actions, 2 requests, 1 thing made (projects).',
    );
  });
});

// What each action came to, and which screens matter: read off the map, so the next run goes to the
// most important screen that is least proven.
describe('status and importance', () => {
  const proven = [
    { ...steps[0], held: true },
    { ...steps[1], held: false },
  ] as DrivenStep[];

  it('counts the runs where an action held, and where it was refuted', () => {
    const map = mergeMap(undefined, mapOfRun(proven, events, '/'), 'r1');
    expect(map.nodes.find((n) => 'action /flows testid=project-create' === n.id)).toMatchObject({
      proven: 1,
    });
    expect(map.nodes.find((n) => 'action /flows link "Chat"' === n.id)).toMatchObject({
      refuted: 1,
    });
  });

  it('names the most important screens first, with how much of each is proven', () => {
    const map = mergeMap(undefined, mapOfRun(proven, events, '/'), 'r1');
    // /flows makes a project (2) and has two actions; /chat/:id is reached from one action (1).
    expect(frontierLine(map)).toBe(
      'Most important first: /flows (2 of 2 actions tried, 1 proven, makes projects), /chat/:id (reached from 1 action).',
    );
  });
});

// Coverage needs what a screen offers, not only what was pressed: the controls each look saw, keyed by
// test id when the engine names it, else by role and a name with its counts taken out. Long names are
// rows (data), never controls: a row is a thing, not a screen's action.
describe('what each screen offers', () => {
  const tree = [
    '- button "Open 2" (ref=e46) [pressed] [testid=issues-open]',
    '- button "Fixed 0" (ref=e47)',
    '- button "Performance Duplicate request: GET /v1/onboarding/connect sent 2 times by one load of a screen" (ref=e44)',
    '- link "Runs" (ref=e30) [testid=nav-runs]',
  ].join('\n');

  it('reads the controls off a snapshot, rows left out', () => {
    expect(controlsOf(tree)).toEqual([
      { role: 'button', name: 'Open #', testid: 'issues-open' },
      { role: 'button', name: 'Fixed #' },
      { role: 'link', name: 'Runs', testid: 'nav-runs' },
    ]);
  });

  it("leaves out a list's items and the page's regions: a control is what a person presses or fills", () => {
    const popup = [
      '- combobox "Where to?" (ref=e1)',
      '- listbox "Suggestions" (ref=e2)',
      '- option "API keys Keys for CI and the Verification API." (ref=e3)',
      '- region "Notifications alt+T" (ref=e4)',
      '- option "Staging" (ref=e5) [testid=env-staging]',
    ].join('\n');
    expect(controlsOf(popup)).toEqual([
      { role: 'combobox', name: 'Where to?' },
      { role: 'option', name: 'Staging', testid: 'env-staging' },
    ]);
  });

  it('reads a name that holds a ref-like part to the last ref, as before', () => {
    const tricky = [
      '- button "Say " (ref=x) to it" (ref=e1) [testid=say]',
      '- button "Empty" (ref=) still" (ref=e2)',
      '- button "" (ref=e3) [testid=]',
      '- button "Open" (ref=e4) [testid=] [testid=open]',
      '- button "No close" (ref=e5',
      '- button "Line\rbreak" (ref=e6)',
      '- button "Ref break" (ref=e\r7) [testid=ref-break]',
      '- button "Rest" (ref=e8) x\r" (ref=e9)',
    ].join('\n');
    expect(controlsOf(tricky)).toEqual([
      { role: 'button', name: 'Say " (ref=x) to it', testid: 'say' },
      { role: 'button', name: 'Empty" (ref=) still' },
      { role: 'button', name: '' },
      { role: 'button', name: 'Open', testid: 'open' },
      { role: 'button', name: 'Ref break', testid: 'ref-break' },
    ]);
  });

  // The snapshot text comes from the page, so the page decides its length and its content. A long
  // run of `" (ref=` or `[testid=` must cost time in proportion to its length. A backtracking
  // pattern took seconds on these lines, and its time grows with the square of the length.
  it('reads a long hostile line in one pass', () => {
    const refs = `- button "${'" (ref='.repeat(30_000)}`;
    const ids = `- button "x" (ref=e1) ${'[testid='.repeat(30_000)}${'[component='.repeat(20_000)}`;
    expect(controlsOf(`${refs}\n${ids}`)).toEqual([{ role: 'button', name: 'x' }]);
  }, 30_000);

  it('keeps a data-named row as one action of its component, seen or pressed', () => {
    const long =
      'Performance: a duplicate request for the onboarding connect screen sent twice on one load';
    expect(controlsOf(`- button "${long}" (ref=e9) [component=IssueRow]`)).toEqual([
      { role: 'button', name: long, component: 'IssueRow' },
    ]);
    const ran = mapOfRun(
      [step({ by: 'role', value: 'button', name: `${long} again`, component: 'IssueRow' }, 10, [])],
      [route('/issues', 1)],
      '/issues',
      [
        {
          screen: '/issues',
          controls: controlsOf(`- button "${long}" (ref=e9) [component=IssueRow]`),
        },
      ],
    );
    const actions = [...ran.nodes.values()].filter((n) => MapNodeKind.ACTION === n.kind);
    expect(actions.map((n) => n.label)).toEqual(['/issues component=IssueRow']);
    expect(actions[0]?.pressed).toBe(true);
  });

  it('puts a control that was seen and one that was pressed on one node, and counts the pressed', () => {
    const seen = [
      {
        screen: '/flows',
        controls: [
          { role: 'button', name: 'Create project', testid: 'project-create' },
          { role: 'button', name: 'Cancel' },
        ],
      },
    ];
    const map = mergeMap(undefined, mapOfRun(steps.slice(0, 1), events, '/', seen), 'r1');
    const actions = map.nodes.filter((n) => MapNodeKind.ACTION === n.kind);
    expect(actions.map((n) => n.id).sort()).toEqual([
      'action /flows button "Cancel"',
      'action /flows testid=project-create',
    ]);
    expect(actions.find((n) => n.id.endsWith('project-create'))).toMatchObject({ pressed: 1 });
    expect(actions.find((n) => n.id.endsWith('"Cancel"'))?.pressed).toBeUndefined();
  });

  it('says how much of each screen has been tried', () => {
    const seen = [
      {
        screen: '/flows',
        controls: [
          { role: 'button', name: 'Create project', testid: 'project-create' },
          { role: 'button', name: 'Cancel' },
        ],
      },
    ];
    const map = mergeMap(undefined, mapOfRun(steps.slice(0, 1), events, '/', seen), 'r1');
    expect(frontierLine(map)).toMatch(/\/flows \(1 of 2 actions tried, 0 proven, makes projects\)/);
  });
});

// A saved flow starts on a screen; a new run starts wherever the app puts it (a fresh account: in
// onboarding). The map knows how to get from one to the other: the actions pressed that led there.
describe('a way from one screen to another', () => {
  const walk = [route('/welcome', 1), route('/', 12), route('/flows', 22)];
  const pressed = [
    step({ by: 'testid', value: 'onboarding-skip', action: 'click' }, 10, walk.slice(1, 2)),
    step({ by: 'role', value: 'link', name: 'Flows', action: 'click' }, 20, walk.slice(2, 3)),
  ];
  const map = mergeMap(undefined, mapOfRun(pressed, walk, '/welcome'), 'r1');

  it('is the actions to press, in order, each by the anchor that pressed it', () => {
    expect(pathTo(map, '/welcome', '/flows')).toEqual([
      { by: 'testid', value: 'onboarding-skip' },
      { by: 'role', value: 'link', name: 'Flows' },
    ]);
  });

  it('is nothing to do when already there, and unknown when the map has no way', () => {
    expect(pathTo(map, '/flows', '/flows')).toEqual([]);
    expect(pathTo(map, '/flows', '/welcome')).toBeUndefined();
  });
});
