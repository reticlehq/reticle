import { describe, expect, it } from 'vitest';
import { appRoute, consequencesFor, jevDriver, jevOptionsFromEnv } from './jev-driver.js';
import { readsDomState } from '@reticlehq/engine/evidence/already-true.js';
import { PredicateSchema } from '@reticlehq/engine/question/predicate/predicate.js';
import type { HistoryEntry, ModelTurn, ToolOutcome } from './harness.js';

/**
 * The driver has no wire in these tests: `fetch` is injected, the same seam `driver.test.ts` uses.
 *
 * What is being proved is the half a System One model CANNOT get wrong for us — that every call the
 * driver emits was built from something actually on the page. The model picks a key out of a set we
 * handed it; if the driver ever emitted a ref it had not just read in a snapshot, the whole claim
 * in this file's header would be false, so that is the property most of these tests are about.
 */

const TREE = [
  '- link "Deployments" (ref=e2)',
  '- button "New deployment" (ref=e5)',
  '- textbox "Service name" (ref=e6)',
  '- button "Sign out" (ref=e4)',
].join('\n');

/** A fetch that answers every call with the same Jev response, and records what it was asked. */
function fakeJev(answers: Record<string, unknown>, seen: { bodies: string[] } = { bodies: [] }) {
  const doFetch = (_url: string, init: { body: string }) => {
    seen.bodies.push(init.body);
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({ answers, usage: { input_tokens: 700, output_tokens: 30 } }),
        ),
    });
  };
  return { doFetch, seen };
}

/** What the driver POSTs, narrowed once so no test has to touch an `any`. */
interface SentBody {
  state: string;
  questions: { next_action: { criteria: Record<string, string> } };
}
const sent = (body: string | undefined): SentBody => JSON.parse(body ?? '{}') as SentBody;

const chose = (option: string, complete = 0): Record<string, unknown> => ({
  next_action: { type: 'choice', choice: option, confidence: 0.95 },
  journey_complete: { type: 'noul', noul: complete },
});

function outcome(name: string, args: Record<string, unknown>, result: unknown): ToolOutcome {
  return { id: `x-${name}`, name, args, result, isError: false };
}

const snapshotOf = (route: string) =>
  outcome('reticle_snapshot', { mode: 'interactive' }, { tree: TREE, status: { route } });

const recordStart = (name: string) =>
  outcome('reticle_record', { action: 'start', recordingName: name }, { ok: true });

const recordStop = (name: string) =>
  outcome('reticle_record', { action: 'stop', recordingName: name }, { ok: true });

/**
 * A drive that has looked at the page and opened a recording for it.
 *
 * LOOK then RECORD, on purpose: a flow is opened per page and named by the route, so the driver
 * cannot name the recording until it knows where it is.
 */
const READY: HistoryEntry[] = [
  { role: 'user', text: 'The app is loaded and connected.' },
  { role: 'tool', outcomes: [snapshotOf('/#/home')] },
  { role: 'tool', outcomes: [recordStart('harness-drive-home')] },
];

const turn = (
  history: HistoryEntry[],
  answers: Record<string, unknown>,
  seen?: { bodies: string[] },
) => {
  const fake = fakeJev(answers, seen);
  return jevDriver({ apiKey: 'k', fetch: fake.doFetch }).turn({
    system: 'drive it',
    tools: [],
    history,
  });
};

describe('the jev driver builds every call from the page', () => {
  /** It cannot name the recording until it knows which page it is on, so it looks first. */
  it('looks at the page before it opens a recording', async () => {
    const result: ModelTurn = await turn([{ role: 'user', text: 'go' }], chose('e5'));
    expect(result.calls[0]?.name).toBe('reticle_snapshot');
  });

  it('names the recording after the page it is on', async () => {
    const history: HistoryEntry[] = [
      { role: 'user', text: 'go' },
      { role: 'tool', outcomes: [snapshotOf('/#/transactions')] },
    ];
    const result = await turn(history, chose('e5'));
    expect(result.calls[0]?.name).toBe('reticle_record');
    expect(result.calls[0]?.args).toMatchObject({
      action: 'start',
      recordingName: 'harness-drive-transactions',
    });
  });

  it('acts on the ref the model chose', async () => {
    const result = await turn(READY, chose('e5'));
    expect(result.calls[0]?.name).toBe('reticle_act_and_wait');
    expect(result.calls[0]?.args).toMatchObject({ ref: 'e5', action: 'click' });
  });

  it('fills a textbox rather than clicking it, with a value drawn from its label', async () => {
    const result = await turn(READY, chose('e6'));
    expect(result.calls[0]?.args).toMatchObject({ ref: 'e6', action: 'fill' });
    expect(result.calls[0]?.args['args']).toEqual({ value: 'reticle harness' });
  });

  it('offers the model only refs that are on the page', async () => {
    const seen = { bodies: [] as string[] };
    await turn(READY, chose('e5'), seen);
    const { criteria } = sent(seen.bodies[0]).questions.next_action;
    const refs = Object.keys(criteria).filter((k) => /^e\d+$/.test(k));
    expect(refs.sort()).toEqual(['e2', 'e4', 'e5', 'e6']);
  });

  /**
   * The failure this driver exists to make impossible.
   *
   * A generating driver can name `e99` because nothing stops it writing the characters. Here the
   * answer is a key from a set the driver built, so an unrecognised one can only mean the upstream
   * broke its own contract — and the driver must not turn that into an action against an element
   * nobody has seen. It looks again instead.
   */
  it('never acts on a ref it did not read in a snapshot', async () => {
    const result = await turn(READY, chose('e99'));
    expect(result.calls[0]?.name).toBe('reticle_snapshot');
  });

  /**
   * Every one of these asserts the REQUIRED args, not just the tool name.
   *
   * An earlier version checked only `action: 'stop'`, and `reticle_record{stop}` identifies the
   * recording by name — so the call was rejected every time, the driver retried the save until the
   * budget ran out, and the run reported a real 24-step journey through a real app with zero flows
   * saved. The tool name being right is the least interesting thing about a call.
   */
  it('stops recording when the model says the journey is covered', async () => {
    const result = await turn(READY, chose('finish'));
    expect(result.calls[0]?.name).toBe('reticle_record');
    expect(result.calls[0]?.args).toMatchObject({
      action: 'stop',
      recordingName: 'harness-drive-home',
    });
  });

  it('stops recording when the model is confident enough that it is done', async () => {
    const result = await turn(READY, chose('e5', 0.95));
    expect(result.calls[0]?.args).toMatchObject({
      action: 'stop',
      recordingName: 'harness-drive-home',
    });
  });

  it('saves a stopped recording before doing anything else', async () => {
    const stopped: HistoryEntry[] = [
      ...READY,
      { role: 'tool', outcomes: [recordStop('harness-drive-home')] },
    ];
    const save = await turn(stopped, chose('e5'));
    expect(save.calls[0]?.name).toBe('reticle_flow_save');
    expect(save.calls[0]?.args['flowName']).toBe('harness-drive-home');
    // A flow with no intent replays, but names only the broken step when it goes red.
    expect(typeof save.calls[0]?.args['intent']).toBe('string');
  });

  /**
   * The defect this closes: one drive used to leave ONE enormous flow behind.
   *
   * A saved flow is the entire product of an explore — it replays forever with no model in the
   * loop. Measured against a real dashboard, the frontier driver segments its recordings into named
   * journeys and left 12 flows; this driver left 1 for the same coverage. The route is the honest
   * name, since it is what actually scopes the journey, and it is one no model has to invent.
   */
  it('closes the journey when the page changes, so each page becomes its own flow', async () => {
    const moved: HistoryEntry[] = [
      ...READY,
      {
        role: 'tool',
        outcomes: [outcome('reticle_act_and_wait', { ref: 'e2', action: 'click' }, { ok: true })],
      },
      { role: 'tool', outcomes: [snapshotOf('/#/transactions')] },
    ];
    const result = await turn(moved, chose('e5'));
    expect(result.calls[0]?.args).toMatchObject({
      action: 'stop',
      recordingName: 'harness-drive-home',
    });
  });

  it('opens a fresh recording named after the page it arrived on', async () => {
    const arrived: HistoryEntry[] = [
      ...READY,
      {
        role: 'tool',
        outcomes: [
          recordStop('harness-drive-home'),
          outcome('reticle_flow_save', { flowName: 'harness-drive-home' }, { ok: true }),
          snapshotOf('/#/settlements'),
        ],
      },
    ];
    const result = await turn(arrived, chose('e5'));
    expect(result.calls[0]?.args).toMatchObject({
      action: 'start',
      recordingName: 'harness-drive-settlements',
    });
  });

  /**
   * Returning to a page already recorded does NOT open another recording for it.
   *
   * Suffixing a revisit (`-2`, `-3`, …) looked tidy and produced `harness-drive-home-2` through
   * `-41` against a real dashboard: destinations that render nothing bounce the route straight
   * back, so it oscillates, and a new recording opened on every bounce. One flow per page is the
   * bound that makes oscillation free.
   */
  it("reuses a page's own flow name on a revisit rather than minting a new one", async () => {
    const revisit: HistoryEntry[] = [
      ...READY,
      {
        role: 'tool',
        outcomes: [
          recordStop('harness-drive-home'),
          outcome('reticle_flow_save', { flowName: 'harness-drive-home' }, { ok: true }),
          snapshotOf('/#/home'),
        ],
      },
    ];
    const result = await turn(revisit, chose('e5'));
    // The page's own name, not `-2`. A revisit refreshes that page's flow; it never adds a new one.
    expect(result.calls[0]?.args['recordingName']).toBe('harness-drive-home');
  });

  it('looks again after acting, rather than choosing from a page that has moved', async () => {
    const acted: HistoryEntry[] = [
      ...READY,
      {
        role: 'tool',
        outcomes: [outcome('reticle_act_and_wait', { ref: 'e5', action: 'click' }, { ok: true })],
      },
    ];
    const result = await turn(acted, chose('e5'));
    expect(result.calls[0]?.name).toBe('reticle_snapshot');
  });

  it('reports what the turn cost, including the second question it had to ask', async () => {
    const result = await turn(READY, chose('e5'));
    // Two calls: one to choose the action, one to choose the consequence to declare. They cannot be
    // merged — Jev answers every question in one pass and the answers are independent, so "what
    // should I expect from the element I am about to choose" cannot be asked alongside the choice.
    expect(result.usage).toEqual({ input: 1400, output: 60, cacheRead: 0, cacheWrite: 0 });
  });

  /**
   * The defect this pins is the one that made the whole driver worthless without looking like it.
   *
   * It emitted `act_and_wait` with no `until`, so the engine returned `no-fault` on every action —
   * "nothing was declared to prove — this is not verification" — and a flow recorded from that
   * drive passes even when the feature is broken. Six actions driven, zero proved, and the run
   * reported as a cheap success.
   */
  it('declares a consequence before acting', async () => {
    const result = await turn(READY, {
      ...chose('e5'),
      expected_consequence: { type: 'choice', choice: 'saves', confidence: 0.9 },
    });
    // BOUND, not bare. A bare `{ kind: 'net' }` proves the action did something and then vanishes
    // at record time, because a replay cannot re-check "some request happened" -- which is how
    // sixteen machine-driven flows came to assert nothing at all.
    expect(result.calls[0]?.args['until']).toEqual({ kind: 'net', method: 'POST' });
  });

  it('declares nothing when nothing observable should change, rather than inventing an expectation', async () => {
    const result = await turn(READY, {
      ...chose('e5'),
      expected_consequence: { type: 'choice', choice: 'nothing', confidence: 0.9 },
    });
    expect(result.calls[0]?.args['until']).toBeUndefined();
  });

  /**
   * Only signal and net may be declared bare. Route and state read LIVE state, so a bare one of
   * those is unconditionally true — there is always a current route — and the engine refuses it as
   * `already_true`. Offering them at all is how this driver spent three runs proving nothing.
   */
  it('never offers a consequence that would be true before the action', () => {
    // Asserted as the PROPERTY rather than as a list of names, because the list has changed twice
    // and a name list fails for the wrong reason every time it does. `readsDomState` is the same
    // function the engine uses to answer `already_true`, so this cannot drift from the rule itself.
    //
    // "Live-reading" is not the defect by itself -- it is what `readsDomState` flags as worth
    // checking BEFORE the act, and the route negation below is flagged for exactly that reason and
    // is correct. The defect is a live-reading kind offered BARE: there is always a current route
    // and always live store state, so `{ kind: 'route' }` is unconditionally true and proves
    // nothing. A negation of the route we are standing on is the opposite: false by construction
    // before the act, true only if the app really moved.
    const offending = Object.entries(consequencesFor('/settings', ['order:placed']))
      .filter(([, c]) => {
        if ('not' === c.predicate['kind']) return false;
        const parsed = PredicateSchema.safeParse(c.predicate);
        return parsed.success && readsDomState(parsed.data);
      })
      .map(([name]) => name);
    expect(offending, `these would be true before the action ran: ${offending.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * The other half of a declaration, and the one that was missing.
   *
   * A consequence that cannot be SAVED leaves a flow that asserts nothing, so every later replay
   * passes as long as the clicks still land. Measured before this: 0 of 22 steps across 16
   * machine-driven flows carried an expectation. The cross-package check lives in
   * `harness-declares-what-a-flow-can-keep.test.ts`; this one only pins that the app's own
   * vocabulary reaches the offers at all, since that is what the driver is responsible for.
   */
  it('offers the signals the app declares, by name', () => {
    const offered = Object.keys(consequencesFor('/settings', ['order:placed', 'export:generated']));
    expect(offered).toContain('signal order:placed');
    expect(offered).toContain('signal export:generated');
  });

  /**
   * The false-red fix, and the defect it closes.
   *
   * With only `signal` and `net` on offer, every click on a nav link — which changes the route
   * client-side and touches neither — was handed a declaration it could not satisfy. Driving a real
   * dashboard, 21 of 42 actions came back `no` and not one was a bug in the application.
   *
   * `not(route contains <the route we are on>)` is falsifiable in both directions: false before the
   * click, true after a real navigation, and still false when the control is dead — which is a
   * CORRECT red.
   */
  it('can declare that an action leaves the current page', async () => {
    const result = await turn(READY, {
      ...chose('e2'),
      expected_consequence: { type: 'choice', choice: 'navigates', confidence: 0.9 },
    });
    expect(result.calls[0]?.args['until']).toEqual({
      kind: 'not',
      predicate: { kind: 'route', contains: '/#/home' },
    });
  });

  /** At the root every route contains `/`, so the negation could never hold. Not offered there. */
  it('does not offer navigation away from the root, where it could never hold', async () => {
    const seen = { bodies: [] as string[] };
    const atRoot: HistoryEntry[] = [
      { role: 'user', text: 'go' },
      { role: 'tool', outcomes: [snapshotOf('/')] },
      { role: 'tool', outcomes: [recordStart('harness-drive-home')] },
    ];
    await turn(atRoot, chose('e5'), seen);
    const body = JSON.parse(seen.bodies[1] ?? '{}') as {
      questions: { expected_consequence: { criteria: Record<string, string> } };
    };
    expect(Object.keys(body.questions.expected_consequence.criteria)).not.toContain('navigates');
  });

  /** An unrecognised consequence claims nothing, rather than guessing one that reads as a defect. */
  it('declares nothing when the answer is not a consequence it offered', async () => {
    const result = await turn(READY, {
      ...chose('e5'),
      expected_consequence: { type: 'choice', choice: 'route', confidence: 0.9 },
    });
    expect(result.calls[0]?.args['until']).toBeUndefined();
  });

  it('carries the element description so the drive reads back as a journey, not as refs', async () => {
    const result = await turn(READY, chose('e5'));
    expect(result.calls[0]?.args['intent']).toContain('New deployment');
  });

  it('tells the model which refs it has already driven', async () => {
    const seen = { bodies: [] as string[] };
    const history: HistoryEntry[] = [
      ...READY,
      {
        role: 'tool',
        outcomes: [outcome('reticle_act_and_wait', { ref: 'e5', action: 'click' }, {})],
      },
      {
        role: 'tool',
        outcomes: [outcome('reticle_snapshot', { mode: 'interactive' }, { tree: TREE })],
      },
    ];
    await turn(history, chose('e2'), seen);
    const body = sent(seen.bodies[0]);
    expect(body.state).toContain('acted on e5');
    expect(body.questions.next_action.criteria['e5']).toContain('already driven');
  });

  it('surfaces an upstream failure instead of returning a turn that proves nothing', async () => {
    const doFetch = () =>
      Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve('rate limited') });
    const driver = jevDriver({ apiKey: 'k', fetch: doFetch });
    await expect(driver.turn({ system: 's', tools: [], history: READY })).rejects.toThrow(
      'jev 429',
    );
  });
});

describe('where the driver gets its key', () => {
  it('is unavailable with nothing configured', () => {
    expect(jevOptionsFromEnv({})).toBeUndefined();
  });

  it('uses a direct key against the upstream by default', () => {
    expect(jevOptionsFromEnv({ JEV_API_KEY: 'j' })).toEqual({ apiKey: 'j' });
  });

  it('uses the platform key against the platform, which is the ordinary path', () => {
    expect(
      jevOptionsFromEnv({
        RETICLE_API_KEY: 'rk_live_x',
        RETICLE_CLOUD_URL: 'https://app.reticle.sh',
      }),
    ).toEqual({
      apiKey: 'rk_live_x',
      baseUrl: 'https://app.reticle.sh',
    });
  });

  /** Reticle ships no Jev key, so a platform key with nowhere to send it is not a usable driver. */
  it('is unavailable with a platform key and no host', () => {
    expect(jevOptionsFromEnv({ RETICLE_API_KEY: 'rk_live_x' })).toBeUndefined();
  });

  it('prefers a direct key, so debugging the upstream never lands on the proxy', () => {
    const options = jevOptionsFromEnv({
      JEV_API_KEY: 'j',
      RETICLE_API_KEY: 'rk_live_x',
      RETICLE_CLOUD_URL: 'https://app.reticle.sh',
    });
    expect(options?.apiKey).toBe('j');
  });
});

/**
 * The gap that cost the cheap driver the headline defect.
 *
 * A refund button is behind `confirmDangerous`, a permission gate a generating driver clears by
 * reading the refusal and re-issuing. Driving a real payments dashboard, the frontier-model arm did
 * exactly that and found a 100x under-refund; this driver could not read an error, moved on, and
 * never reached the flow at all. The retry is mechanical now, which is where it belongs.
 */
describe('a control the destructive gate refused', () => {
  const refused = (ref: string): HistoryEntry => ({
    role: 'tool',
    outcomes: [
      {
        id: 'x',
        name: 'reticle_act_and_wait',
        args: { ref, action: 'click' },
        result: {
          error: 'potentially destructive action blocked; retry with args.confirmDangerous=true',
        },
        isError: true,
      },
    ],
  });

  it('retries it carrying the permission', async () => {
    const history: HistoryEntry[] = [
      ...READY,
      refused('e5'),
      {
        role: 'tool',
        outcomes: [
          outcome(
            'reticle_snapshot',
            { mode: 'interactive' },
            { tree: TREE, status: { route: '/#/home' } },
          ),
        ],
      },
    ];
    const result = await turn(history, chose('e5'));
    expect(result.calls[0]?.args['args']).toMatchObject({ confirmDangerous: true });
  });

  it('does not grant the permission to a control that was never refused', async () => {
    const result = await turn(READY, chose('e5'));
    expect(result.calls[0]?.args['args']).toBeUndefined();
  });

  /** A refused act never reached the app, so it is not something this drive has driven. */
  it('does not count it as already driven', async () => {
    const seen = { bodies: [] as string[] };
    const history: HistoryEntry[] = [
      ...READY,
      refused('e5'),
      {
        role: 'tool',
        outcomes: [
          outcome(
            'reticle_snapshot',
            { mode: 'interactive' },
            { tree: TREE, status: { route: '/#/home' } },
          ),
        ],
      },
    ];
    await turn(history, chose('e2'), seen);
    const body = JSON.parse(seen.bodies[0] ?? '{}') as {
      questions: { next_action: { criteria: Record<string, string> } };
    };
    expect(body.questions.next_action.criteria['e5']).not.toContain('already driven');
  });

  it('keeps the fill value when the permission is also granted', async () => {
    const history: HistoryEntry[] = [
      ...READY,
      refused('e6'),
      {
        role: 'tool',
        outcomes: [
          outcome(
            'reticle_snapshot',
            { mode: 'interactive' },
            { tree: TREE, status: { route: '/#/home' } },
          ),
        ],
      },
    ];
    const result = await turn(history, chose('e6'));
    expect(result.calls[0]?.args['args']).toEqual({
      confirmDangerous: true,
      value: 'reticle harness',
    });
  });
});

/**
 * The loop this closes had a receipt: `harness-drive-settings-2` through `-49`.
 *
 * Closing the journey on an empty page and returning let the scaffolding save it, see no open
 * recording, and open another for the SAME page — which still had nothing on it. Against a real
 * dashboard that spent the whole 250-step budget on 28 actions and wrote 48 junk flows.
 */
describe('a page with nothing to act on', () => {
  const EMPTY = '- heading "Nothing here"';

  it('winds the drive up instead of reopening a recording for the same page', async () => {
    // ONE driver across both turns, which is how the loop uses it: "the app is covered" leaves no
    // trace in the history, so it is the one fact this driver holds rather than derives.
    const fake = fakeJev(chose('e5'));
    const driver = jevDriver({ apiKey: 'k', fetch: fake.doFetch });
    const blank: HistoryEntry[] = [
      ...READY,
      {
        role: 'tool',
        outcomes: [
          outcome(
            'reticle_snapshot',
            { mode: 'interactive' },
            { tree: EMPTY, status: { route: '/#/home' } },
          ),
        ],
      },
    ];

    const stop = await driver.turn({ system: 's', tools: [], history: blank });
    expect(stop.calls[0]?.args).toMatchObject({
      action: 'stop',
      recordingName: 'harness-drive-home',
    });

    // Once that recording is saved the drive FINISHES; it does not open another on the same page.
    const after: HistoryEntry[] = [
      ...blank,
      {
        role: 'tool',
        outcomes: [
          recordStop('harness-drive-home'),
          outcome('reticle_flow_save', { flowName: 'harness-drive-home' }, { ok: true }),
        ],
      },
    ];
    const done = await driver.turn({ system: 's', tools: [], history: after });
    expect(done.calls[0]?.name).toBe('finish');
  });
});

/**
 * Where the driver POSTs, which is not the same host-to-host.
 *
 * TypeSafe serves `/v1/systemone`; Reticle's platform serves the same wire shape at
 * `/v1/model/systemone` and forwards with ITS key. Getting this wrong broke the one claim the
 * feature exists to make — a daemon holding only a platform key chose the `jev` driver correctly
 * and then 404'd against the upstream's path on the platform's host, driving nothing. It survived
 * an earlier "end to end" run only because that daemon also had a direct JEV_API_KEY exported, so
 * it never went near the platform.
 */
describe('which endpoint the jev driver posts to', () => {
  const seen = () => {
    const urls: string[] = [];
    const doFetch = (url: string) => {
      urls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ answers: chose('e5'), usage: { input_tokens: 1, output_tokens: 1 } }),
          ),
      });
    };
    return { urls, doFetch };
  };

  it('posts to TypeSafe directly when no base URL is configured', async () => {
    const fake = seen();
    await jevDriver({ apiKey: 'k', fetch: fake.doFetch }).turn({
      system: 's',
      tools: [],
      history: READY,
    });
    expect(fake.urls[0]).toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('posts to the platform path when driving through the platform', async () => {
    const fake = seen();
    await jevDriver({
      apiKey: 'rk_live_x',
      baseUrl: 'https://app.reticle.sh',
      fetch: fake.doFetch,
    }).turn({ system: 's', tools: [], history: READY });
    expect(fake.urls[0]).toBe('https://app.reticle.sh/v1/model/systemone');
  });
});

/**
 * Following the plan the caller read out of `.reticle`.
 *
 * The cheap half runs FIRST and costs no model call at all: a journey already recorded replays
 * deterministically, and re-driving it pays a loop to rediscover what is on disk. Before this, every
 * run started from zero.
 */
describe('a drive that was handed a plan', () => {
  const PLAN = [
    { kind: 'replay', target: 'sign-in', why: 'must still hold: signal auth:ok' },
    { kind: 'replay', target: 'checkout', why: 'must still hold: net POST /api/order' },
    { kind: 'drive', target: 'order:placed', why: 'declared and never asserted' },
  ];

  const withPlan = (
    history: HistoryEntry[],
    answers: Record<string, unknown>,
    seen?: { bodies: string[] },
  ) => {
    const fake = fakeJev(answers, seen);
    return jevDriver({ apiKey: 'k', plan: PLAN, fetch: fake.doFetch }).turn({
      system: 'drive it',
      tools: [],
      history,
    });
  };

  const replayed = (name: string): HistoryEntry => ({
    role: 'tool',
    outcomes: [outcome('reticle_flow_replay', { flowName: name }, { passed: true })],
  });

  it('replays a recorded journey before it drives anything', async () => {
    const result = await withPlan(READY, chose('e5'));
    expect(result.calls[0]?.name).toBe('reticle_flow_replay');
    expect(result.calls[0]?.args['flowName']).toBe('sign-in');
  });

  /** No decision to take, so no model call: the caller already decided this was worth doing. */
  it('spends no model call on a replay', async () => {
    const seen = { bodies: [] as string[] };
    await withPlan(READY, chose('e5'), seen);
    expect(seen.bodies).toHaveLength(0);
  });

  it('advances to the next recorded journey rather than looping on the first', async () => {
    const result = await withPlan([...READY, replayed('sign-in')], chose('e5'));
    expect(result.calls[0]?.args['flowName']).toBe('checkout');
  });

  /** A replay that went red is a FINDING; re-running it would bury it in a loop. */
  it('moves on from a replay that failed, rather than repeating it', async () => {
    const failed: HistoryEntry = {
      role: 'tool',
      outcomes: [outcome('reticle_flow_replay', { flowName: 'sign-in' }, { passed: false })],
    };
    const result = await withPlan([...READY, failed], chose('e5'));
    expect(result.calls[0]?.args['flowName']).toBe('checkout');
  });

  it('drives only once every recorded journey has been replayed', async () => {
    const done = [...READY, replayed('sign-in'), replayed('checkout')];
    const result = await withPlan(done, chose('e5'));
    expect(result.calls[0]?.name).toBe('reticle_act_and_wait');
  });

  /** A model choosing a control should be reading what it is trying to prove, not recalling it. */
  it('tells the model which declared intent it is currently trying to prove', async () => {
    const seen = { bodies: [] as string[] };
    await withPlan([...READY, replayed('sign-in'), replayed('checkout')], chose('e5'), seen);
    expect(sent(seen.bodies[0]).state).toContain('order:placed');
    expect(sent(seen.bodies[0]).state).toContain('declared and never asserted');
  });
});

/**
 * Routing to a TOOL, not just to a control.
 *
 * The driver used to hard-code every tool and ask only which element — so a drive could never
 * decide to go and look at what the app actually did, only to click something else. Reading a
 * channel is the choice that turns "the page looks fine" into evidence.
 */
describe('choosing which tool to use next', () => {
  it('offers reading the app’s own channels, not only its controls', async () => {
    const seen = { bodies: [] as string[] };
    await turn(READY, chose('e5'), seen);
    const offered = Object.keys(sent(seen.bodies[0]).questions.next_action.criteria);
    expect(offered).toContain('observe_what_the_app_did');
    expect(offered).toContain('read_app_state');
  });

  it('routes to the observation channel when it picks one', async () => {
    const result = await turn(READY, chose('observe_what_the_app_did'));
    expect(result.calls[0]?.name).toBe('reticle_observe');
  });

  it('routes to the app state when it picks that', async () => {
    const result = await turn(READY, chose('read_app_state'));
    expect(result.calls[0]?.name).toBe('reticle_state');
  });

  /** A read changes nothing, so it is not something the drive has "driven". */
  it('does not count a read as an action already driven', async () => {
    const seen = { bodies: [] as string[] };
    const read: HistoryEntry = {
      role: 'tool',
      outcomes: [outcome('reticle_observe', {}, { events: [] })],
    };
    await turn([...READY, read], chose('e5'), seen);
    expect(sent(seen.bodies[0]).state).toContain('(nothing yet)');
  });
});

/**
 * A declared consequence must be about the APPLICATION, never about Reticle.
 *
 * The pooled launcher appends `__reticle_opened=1` to the URL it opens, and that parameter reached a
 * declared predicate: "this click leaves a route containing /?__reticle_opened=1". On a hash-routed
 * app the query string never changes -- only the fragment does -- so the claim could never hold and
 * every navigation link was a guaranteed red about our own query parameter. Measured on a real
 * dashboard, and visible only once a failed action started reporting what it had claimed.
 */
describe('the route a consequence is declared against', () => {
  it("drops Reticle's own opener parameter", () => {
    expect(appRoute('/?__reticle_opened=1')).toBe('/');
  });

  it("keeps the app's own query parameters", () => {
    expect(appRoute('/orders?status=failed&__reticle_opened=1')).toBe('/orders?status=failed');
  });

  /** The fragment is the only part that moves on a hash-routed app, so it is the load-bearing part. */
  it('keeps the fragment, which is the whole route on a hash-routed app', () => {
    expect(appRoute('/?__reticle_opened=1#/transactions')).toBe('/#/transactions');
  });

  it('leaves an ordinary route alone', () => {
    expect(appRoute('/settings/team')).toBe('/settings/team');
  });

  it('drops every reserved parameter, not just the opener', () => {
    expect(appRoute('/x?__reticle_session=s1&__reticle_project=p1&keep=1')).toBe('/x?keep=1');
  });
});
