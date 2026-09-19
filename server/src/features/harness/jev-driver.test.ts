import { describe, expect, it } from 'vitest';
import { jevDriver, jevOptionsFromEnv } from './jev-driver.js';
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

/** History for a drive that has started recording and just taken a snapshot. */
const READY: HistoryEntry[] = [
  { role: 'user', text: 'The app is loaded and connected.' },
  {
    role: 'tool',
    outcomes: [
      outcome('reticle_record', { action: 'start', recordingName: 'harness-drive' }, { ok: true }),
      outcome('reticle_snapshot', { mode: 'interactive' }, { tree: TREE }),
    ],
  },
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
  it('starts by recording, before it has looked at anything', async () => {
    const result: ModelTurn = await turn([{ role: 'user', text: 'go' }], chose('e5'));
    expect(result.calls[0]?.name).toBe('reticle_record');
    expect(result.calls[0]?.args).toMatchObject({
      action: 'start',
      recordingName: 'harness-drive',
    });
  });

  it('looks at the page once recording has started', async () => {
    const history: HistoryEntry[] = [
      { role: 'user', text: 'go' },
      { role: 'tool', outcomes: [outcome('reticle_record', { action: 'start' }, { ok: true })] },
    ];
    const result = await turn(history, chose('e5'));
    expect(result.calls[0]?.name).toBe('reticle_snapshot');
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
    expect(result.calls[0]?.args).toMatchObject({ action: 'stop', recordingName: 'harness-drive' });
  });

  it('stops recording when the model is confident enough that it is done', async () => {
    const result = await turn(READY, chose('e5', 0.95));
    expect(result.calls[0]?.args).toMatchObject({ action: 'stop', recordingName: 'harness-drive' });
  });

  it('saves the flow after stopping, then finishes', async () => {
    const stopped: HistoryEntry[] = [
      ...READY,
      { role: 'tool', outcomes: [outcome('reticle_record', { action: 'stop' }, { ok: true })] },
    ];
    const save = await turn(stopped, chose('e5'));
    expect(save.calls[0]?.name).toBe('reticle_flow_save');
    expect(save.calls[0]?.args['flowName']).toBe('harness-drive');
    // A flow with no intent replays, but names only the broken step when it goes red.
    expect(typeof save.calls[0]?.args['intent']).toBe('string');

    const saved: HistoryEntry[] = [
      ...stopped,
      { role: 'tool', outcomes: [outcome('reticle_flow_save', { flowName: 'f' }, { ok: true })] },
    ];
    const done = await turn(saved, chose('e5'));
    expect(done.calls[0]?.name).toBe('finish');
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

  it('reports what the turn cost', async () => {
    const result = await turn(READY, chose('e5'));
    expect(result.usage).toEqual({ input: 700, output: 30, cacheRead: 0, cacheWrite: 0 });
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
        RETICLE_CLOUD_KEY: 'rk_live_x',
        RETICLE_CLOUD_URL: 'https://app.reticle.sh',
      }),
    ).toEqual({
      apiKey: 'rk_live_x',
      baseUrl: 'https://app.reticle.sh',
    });
  });

  /** Reticle ships no Jev key, so a platform key with nowhere to send it is not a usable driver. */
  it('is unavailable with a platform key and no host', () => {
    expect(jevOptionsFromEnv({ RETICLE_CLOUD_KEY: 'rk_live_x' })).toBeUndefined();
  });

  it('prefers a direct key, so debugging the upstream never lands on the proxy', () => {
    const options = jevOptionsFromEnv({
      JEV_API_KEY: 'j',
      RETICLE_CLOUD_KEY: 'rk_live_x',
      RETICLE_CLOUD_URL: 'https://app.reticle.sh',
    });
    expect(options?.apiKey).toBe('j');
  });
});
