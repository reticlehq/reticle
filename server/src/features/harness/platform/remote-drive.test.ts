import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import {
  NO_OWN_TAB,
  REMOTE_DRIVE_ENDED,
  driveVerdict,
  endDrivenTab,
  pickDriveSession,
  pickOwnDriveSession,
  startRemoteDrives,
  type RemoteDriveDeps,
  type RemoteDrives,
} from './remote-drive.js';

const LINKED = { [ReticleEnv.API_KEY]: 'k', [ReticleEnv.CLOUD_URL]: 'https://p.test/' };

let running: RemoteDrives | undefined;
afterEach(() => running?.stop());

const platform = (drive: unknown) => {
  const calls: { url: string; method: string; body?: unknown; auth: string | undefined }[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>;
    const body = 'string' === typeof init.body ? init.body : undefined;
    calls.push({
      url,
      method: init.method ?? 'GET',
      ...(undefined === body ? {} : { body: JSON.parse(body) as unknown }),
      auth: headers['authorization'],
    });
    return Promise.resolve(new Response(JSON.stringify({ drive }), { status: 200 }));
  };
  return { calls, fetch };
};

const start = (overrides: Partial<RemoteDriveDeps>): RemoteDrives => {
  running = startRemoteDrives({
    env: () => Promise.resolve(LINKED),
    connected: () => true,
    drive: () => Promise.resolve({ ok: true, summary: 'proved' }),
    intervalMs: 60_000,
    ...overrides,
  });
  return running;
};

describe('drives the platform chat asked for', () => {
  it('takes a waiting drive, runs it here and reports how it ended', async () => {
    const p = platform({ id: 'ld_1', goal: 'sign up works' });
    const goals: string[] = [];
    await start({
      fetch: p.fetch,
      drive: (goal) => {
        goals.push(goal);
        return Promise.resolve({ ok: true, summary: '1 of 1 proved' });
      },
    }).tick();

    expect(goals).toEqual(['sign up works']);
    expect(p.calls[0]).toMatchObject({
      url: 'https://p.test/v1/harness/local-drives/next',
      method: 'GET',
      auth: 'Bearer k',
    });
    expect(p.calls[1]).toMatchObject({
      url: 'https://p.test/v1/harness/local-drives/ld_1',
      method: 'POST',
      body: { ok: true, summary: '1 of 1 proved', filmed: false },
    });
  });

  it('reports a drive that threw as failed, in its own words', async () => {
    const p = platform({ id: 'ld_2', goal: 'x' });
    await start({ fetch: p.fetch, drive: () => Promise.reject(new Error('not entitled')) }).tick();
    expect(p.calls[1]?.body).toMatchObject({ ok: false, summary: 'not entitled', filmed: false });
  });

  it('settles the driven tab once the drive is over, even when it threw', async () => {
    const settled: { sessionId: string | undefined; ok: boolean }[] = [];
    const settle: RemoteDriveDeps['settle'] = (sessionId, outcome) =>
      settled.push({ sessionId, ok: outcome.ok });
    await start({
      fetch: platform({ id: 'ld_s', goal: 'x' }).fetch,
      pick: () => 'tab-1',
      settle,
    }).tick();
    running?.stop();
    await start({
      fetch: platform({ id: 'ld_t', goal: 'x' }).fetch,
      pick: () => 'tab-2',
      drive: () => Promise.reject(new Error('boom')),
      settle,
    }).tick();
    expect(settled).toEqual([
      { sessionId: 'tab-1', ok: true },
      { sessionId: 'tab-2', ok: false },
    ]);
  });

  it('ends the driven tab with a line saying whether the drive proved anything', () => {
    const said: string[] = [];
    const tab = { autoEnd: (text: string) => void said.push(text) };
    endDrivenTab(tab, { ok: true, summary: '' });
    endDrivenTab(tab, { ok: false, summary: '' });
    endDrivenTab(undefined, { ok: true, summary: '' });
    expect(said).toEqual([REMOTE_DRIVE_ENDED.PROVED, REMOTE_DRIVE_ENDED.NOT_PROVED]);
  });

  it('drives only a tab of the project whose credential claimed the drive', async () => {
    const tabs = [
      { sessionId: 'b', url: 'http://localhost:5174/', lastSeenMs: 0, hidden: false },
      { sessionId: 'a', url: 'http://localhost:5173/', lastSeenMs: 1, hidden: false },
    ];
    const keyOf = (id: string): Promise<string | undefined> =>
      Promise.resolve({ a: 'key-a', b: 'key-b' }[id]);
    expect(await pickOwnDriveSession(tabs, 'drive it', 'key-a', keyOf)).toBe('a');
    // Even a request naming B's address is not run in B with A's credential.
    expect(await pickOwnDriveSession(tabs, 'on http://localhost:5174', 'key-a', keyOf)).toBe('a');
    expect(await pickOwnDriveSession(tabs, 'drive it', 'key-c', keyOf)).toBeNull();
  });

  it('refuses a drive no tab of its project can take, without driving another', async () => {
    const p = platform({ id: 'ld_o', goal: 'x' });
    const drove: string[] = [];
    await start({
      fetch: p.fetch,
      pick: () => Promise.resolve(null),
      drive: (goal) => {
        drove.push(goal);
        return Promise.resolve({ ok: true, summary: 'proved' });
      },
    }).tick();
    expect(drove).toEqual([]);
    expect(p.calls[1]?.body).toMatchObject({
      ok: false,
      summary: NO_OWN_TAB,
      verdict: 'unknown',
      filmed: false,
    });
  });

  it('does not ask while no app is connected, so the chat can say so', async () => {
    const p = platform({ id: 'ld_3', goal: 'x' });
    await start({ fetch: p.fetch, connected: () => false }).tick();
    expect(p.calls).toHaveLength(0);
  });

  it("asks with another project's credential when told a drive is waiting, even with nothing open", async () => {
    const p = platform({ id: 'ld_9', goal: 'pay' });
    const goals: string[] = [];
    await start({
      fetch: p.fetch,
      connected: () => false,
      drive: (goal) => {
        goals.push(goal);
        return Promise.resolve({ ok: true, summary: 'proved' });
      },
    }).tick({ url: 'https://other.test', apiKey: 'key-b' });
    expect(goals).toEqual(['pay']);
    expect(p.calls[0]).toMatchObject({
      url: 'https://other.test/v1/harness/local-drives/next',
      auth: 'Bearer key-b',
    });
  });

  it('hands the tab picker the app the chat attached the drive to', async () => {
    const p = platform({
      id: 'ld_8',
      goal: 'pay',
      appKey: 'k_shop',
      appUrl: 'http://localhost:3000/',
    });
    const asked: unknown[] = [];
    await start({
      fetch: p.fetch,
      pick: (_goal, _key, app) => {
        asked.push(app);
        return 'tab-1';
      },
    }).tick();
    expect(asked).toEqual([{ key: 'k_shop', url: 'http://localhost:3000/' }]);
  });

  it('does not ask when this machine is not linked', async () => {
    const p = platform(null);
    await start({ fetch: p.fetch, env: () => Promise.resolve({}) }).tick();
    expect(p.calls).toHaveLength(0);
  });

  it('does nothing when no drive is waiting', async () => {
    const p = platform(null);
    let drove = false;
    await start({
      fetch: p.fetch,
      drive: () => {
        drove = true;
        return Promise.resolve({ ok: true, summary: '' });
      },
    }).tick();
    expect(drove).toBe(false);
    expect(p.calls).toHaveLength(1);
  });

  it('runs one drive at a time', async () => {
    const p = platform({ id: 'ld_4', goal: 'x' });
    let release: () => void = () => undefined;
    let drives = 0;
    const remote = start({
      fetch: p.fetch,
      drive: () => {
        drives += 1;
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: '' });
        });
      },
    });
    const first = remote.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await remote.tick();
    release();
    await first;
    expect(drives).toBe(1);
  });
});

describe('the live picture of a drive the chat asked for', () => {
  const jpeg = (byte: number): Uint8Array => new Uint8Array([byte, byte, byte]);

  it('sends what the driven tab shows while it drives, skipping repeats, and stops after', async () => {
    const p = platform({ id: 'ld_5', goal: 'x' });
    const shots = [jpeg(1), jpeg(1), jpeg(2)];
    let release: () => void = () => undefined;
    const remote = start({
      fetch: p.fetch,
      frameIntervalMs: 5,
      frame: () => Promise.resolve(shots.shift()),
      drive: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: '' });
        }),
    });
    const ticking = remote.tick();
    // Until the shots run out, not for a fixed time: Windows' timer resolution fit one 5ms tick in 60ms.
    await vi.waitFor(() => expect(shots).toHaveLength(0), { timeout: 10_000 });
    release();
    await ticking;
    const sent = p.calls.filter((c) => c.url.endsWith('/ld_5/frames'));
    expect(sent.map((c) => c.body)).toEqual([
      { jpeg: Buffer.from(jpeg(1)).toString('base64') },
      { jpeg: Buffer.from(jpeg(2)).toString('base64') },
    ]);
    const after = p.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(p.calls.length).toBe(after);
    expect(p.calls.find((c) => c.url.endsWith('/ld_5'))?.body).toMatchObject({ filmed: true });
  });

  /*
   * The person's own tab, which the SDK reaches and no camera does, gives no picture at all. The
   * result says so, so the chat can tell them why there is no video instead of showing an empty one.
   */
  it('says the drive was not filmed when the tab had no camera', async () => {
    const p = platform({ id: 'ld_7', goal: 'x' });
    let release: () => void = () => undefined;
    const remote = start({
      fetch: p.fetch,
      frameIntervalMs: 5,
      frame: () => Promise.resolve(undefined),
      drive: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: '' });
        }),
    });
    const ticking = remote.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await ticking;
    expect(p.calls.find((c) => c.url.endsWith('/ld_7'))?.body).toMatchObject({ filmed: false });
  });

  it('sends no picture when the drive asked not to be recorded', async () => {
    const p = platform({ id: 'ld_6', goal: 'x', record: false });
    let release: () => void = () => undefined;
    const remote = start({
      fetch: p.fetch,
      frameIntervalMs: 5,
      frame: () => Promise.resolve(jpeg(1)),
      drive: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: '' });
        }),
    });
    const ticking = remote.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await ticking;
    expect(p.calls.some((c) => c.url.endsWith('/frames'))).toBe(false);
  });
});

describe('which tab a chat-requested drive uses', () => {
  const tab = (sessionId: string, url: string, lastSeenMs: number, hidden = false) => ({
    sessionId,
    url,
    lastSeenMs,
    hidden,
  });

  it('takes the tab whose address the request names', () => {
    const tabs = [tab('a', 'http://localhost:3000/', 5), tab('b', 'http://localhost:4313/x', 50)];
    expect(pickDriveSession(tabs, 'On http://localhost:4313, sign in works')).toBe('b');
  });

  it('otherwise takes a visible tab over a hidden one, then the one heard from last', () => {
    const tabs = [
      tab('hidden', 'http://localhost:4313/', 1, true),
      tab('old', 'http://localhost:4313/', 900),
      tab('fresh', 'http://localhost:4313/', 10),
    ];
    expect(pickDriveSession(tabs, 'the dashboard loads')).toBe('fresh');
  });

  it('answers nothing when no tab is connected', () => {
    expect(pickDriveSession([], 'x')).toBeUndefined();
  });

  it('drives and films the tab it picked, so two open tabs never confuse the drive', async () => {
    const p = platform({ id: 'ld_7', goal: 'x' });
    const driven: (string | undefined)[] = [];
    const filmed: (string | undefined)[] = [];
    let release: () => void = () => undefined;
    const remote = start({
      fetch: p.fetch,
      frameIntervalMs: 5,
      pick: () => 'tab-2',
      frame: (sessionId) => {
        filmed.push(sessionId);
        return Promise.resolve(new Uint8Array([filmed.length]));
      },
      drive: (_goal, sessionId) => {
        driven.push(sessionId);
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: '' });
        });
      },
    });
    const ticking = remote.tick();
    await vi.waitFor(() => expect(filmed.length).toBeGreaterThan(0), { timeout: 10_000 });
    release();
    await ticking;
    expect(driven).toEqual(['tab-2']);
    expect(new Set(filmed)).toEqual(new Set(['tab-2']));
  });
});

describe('the verdict a chat-requested drive reports', () => {
  it('reads a goal judged missed, with no check against it, as not proved rather than failed', () => {
    expect(driveVerdict({ goalMet: false, proved: true })).toBe('unknown');
    expect(driveVerdict({ goalMet: false, proved: false })).toBe('unknown');
    const undecided = { held: 0, failed: 0, undecided: 2 };
    expect(driveVerdict({ goalMet: false, proved: true, checks: undecided })).toBe('unknown');
    expect(
      driveVerdict({ goalMet: false, proved: true, checks: { held: 2, failed: 0, undecided: 0 } }),
    ).toBe('unknown');
    expect(
      driveVerdict({ goalMet: true, proved: true, checks: { held: 1, failed: 0, undecided: 0 } }),
    ).toBe('yes');
  });

  it('falls back to the goals the harness checked itself', () => {
    expect(driveVerdict({ proved: true, goals: [{ verified: 'yes' }, { verified: 'no' }] })).toBe(
      'unknown',
    );
    expect(
      driveVerdict({
        proved: true,
        goals: [{ verified: 'yes' }],
        checks: { held: 1, failed: 0, undecided: 0 },
      }),
    ).toBe('yes');
  });

  it('refutes a goal on its quoted texts only when none of them is on the final page', () => {
    // "goes from "Count is 0" to "Count is 1"": the drive ends on "Count is 1", so the start state is
    // rightly gone. It marked a working counter "Failed"; the goal's own judgement decides instead.
    const counter = [{ verified: 'no' }, { verified: 'yes' }];
    const held = { held: 1, failed: 0, undecided: 0 };
    expect(driveVerdict({ goalMet: true, proved: true, goals: counter, checks: held })).toBe('yes');
    expect(driveVerdict({ proved: true, goals: counter, checks: held })).toBe('unknown');
    expect(driveVerdict({ proved: true, goals: [{ verified: 'no' }], checks: held })).toBe('no');
    expect(driveVerdict({ proved: true, goals: [{ verified: 'unknown' }], checks: held })).toBe(
      'unknown',
    );
  });

  it('is never yes over a check that failed, whatever the model said of the goal', () => {
    // A check that ran and came back "no" is evidence against, not proof: "proved" only says one ran.
    expect(
      driveVerdict({ goalMet: true, proved: true, checks: { held: 0, failed: 1, undecided: 0 } }),
    ).toBe('no');
    expect(
      driveVerdict({ goalMet: true, proved: true, checks: { held: 2, failed: 1, undecided: 0 } }),
    ).toBe('no');
  });

  it('is yes only with a check that held behind the goal', () => {
    expect(
      driveVerdict({ goalMet: true, proved: true, checks: { held: 1, failed: 0, undecided: 2 } }),
    ).toBe('yes');
    expect(
      driveVerdict({ goalMet: true, proved: true, checks: { held: 0, failed: 0, undecided: 3 } }),
    ).toBe('unknown');
  });

  it('is unknown when the drive broke or nothing settled the goal, never a pass by default', () => {
    expect(driveVerdict({ goalMet: true, proved: true, error: 'browser died' })).toBe('unknown');
    expect(driveVerdict({ proved: true })).toBe('unknown');
    expect(driveVerdict({ goalMet: true, proved: false })).toBe('unknown');
  });
});

/**
 * A drive request carries a spec the platform may grow without this daemon changing: what it can
 * apply it applies, and it says what it applied and what it ignored. A drive the platform
 * orchestrates is a tool session: this daemon runs the calls it is given and returns their results.
 */
describe('a drive with a spec', () => {
  const routed = (answers: Record<string, unknown[]>) => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      const body =
        'string' === typeof init.body
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({ url, ...(body === undefined ? {} : { body }) });
      const key = Object.keys(answers).find((path) => url.endsWith(path));
      const queue = key === undefined ? undefined : answers[key];
      const answer = queue !== undefined && 1 < queue.length ? queue.shift() : queue?.[0];
      return Promise.resolve(new Response(JSON.stringify(answer ?? {}), { status: 200 }));
    };
    return { calls, fetch };
  };

  it('prepares the target it asks for, and reports what it applied and what it ignored', async () => {
    const p = routed({
      '/next': [
        {
          drive: { id: 'ld_s', goal: 'pay', spec: { target: 'headless', hud: 'hidden', zoom: 2 } },
        },
      ],
    });
    const prepared: unknown[] = [];
    await start({
      fetch: p.fetch,
      prepare: (drive) => {
        prepared.push(drive.spec);
        return Promise.resolve({
          sessionId: 'lease-1',
          applied: { target: 'headless', mode: 'local', hud: 'hidden', sessionId: 'lease-1' },
          ignored: [{ field: 'hud', reason: 'unavailable' }],
        });
      },
    }).tick();
    expect(prepared).toEqual([{ target: 'headless', hud: 'hidden' }]);
    const result = p.calls.find((c) => c.url.endsWith('/ld_s'))?.body;
    expect(result).toMatchObject({
      ok: true,
      applied: { target: 'headless', sessionId: 'lease-1' },
      ignored: [
        { field: 'zoom', reason: 'unknown' },
        { field: 'hud', reason: 'unavailable' },
      ],
    });
  });

  it('runs a drive the platform orchestrates as a tool session, never its own Harness', async () => {
    const p = routed({
      '/next': [{ drive: { id: 'ld_p', goal: 'pay', spec: { mode: 'platform' } } }],
      '/session': [
        { calls: [{ seq: 1, tool: 'reticle_look', args: { action: 'page' } }] },
        { calls: [{ seq: 2, tool: 'reticle_nope', args: {} }] },
        { done: true },
      ],
    });
    const invoked: [string, unknown][] = [];
    let drove = false;
    await start({
      fetch: p.fetch,
      prepare: () =>
        Promise.resolve({
          sessionId: 'tab-1',
          applied: { target: 'tab', mode: 'platform', sessionId: 'tab-1' },
          ignored: [],
        }),
      session: () => ({
        tools: [{ name: 'reticle_look', description: 'read the page', inputSchema: {} }],
        invoke: (tool, args) => {
          invoked.push([tool, args]);
          return 'reticle_nope' === tool
            ? Promise.reject(new Error('unknown reticle tool'))
            : Promise.resolve({ tree: 'button "Pay"' });
        },
      }),
      drive: () => {
        drove = true;
        return Promise.resolve({ ok: true, summary: '' });
      },
      now: () => 0,
    }).tick();
    expect(drove).toBe(false);
    expect(invoked).toEqual([
      ['reticle_look', { action: 'page' }],
      ['reticle_nope', {}],
    ]);
    const asks = p.calls.filter((c) => c.url.endsWith('/session')).map((c) => c.body);
    expect(asks).toEqual([
      expect.objectContaining({
        results: [],
        applied: { target: 'tab', mode: 'platform', sessionId: 'tab-1' },
        // What this daemon can run, so the platform's loop offers its model exactly those tools.
        tools: [{ name: 'reticle_look', description: 'read the page', inputSchema: {} }],
      }),
      expect.objectContaining({
        results: [{ seq: 1, ok: true, result: { tree: 'button "Pay"' }, ms: 0 }],
      }),
      expect.objectContaining({
        results: [{ seq: 2, ok: false, error: 'unknown reticle tool', ms: 0 }],
      }),
    ]);
    // The platform decided the drive, so it keeps the result; the daemon posts none of its own.
    expect(p.calls.some((c) => c.url.endsWith('/ld_p'))).toBe(false);
  });
});

/**
 * A network blip in the middle of a platform drive ended it on the daemon, and the platform showed it
 * "driving" for half an hour. An ask that failed is sent again, the SAME ask under the same number, so
 * the platform answers it once; a refusal stops the drive at once.
 */
describe('a tool session over a network that fails', () => {
  const session = (statuses: (number | 'drop')[], replies: unknown[]) => {
    const asks: { ask: unknown; results: unknown }[] = [];
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith('/next'))
        return Promise.resolve(
          new Response(
            JSON.stringify({ drive: { id: 'ld_r', goal: 'pay', spec: { mode: 'platform' } } }),
          ),
        );
      const body = JSON.parse('string' === typeof init.body ? init.body : '{}') as {
        ask: unknown;
        results: unknown;
      };
      asks.push({ ask: body.ask, results: body.results });
      const status = statuses.shift() ?? 200;
      if ('drop' === status) return Promise.reject(new Error('socket hang up'));
      return Promise.resolve(
        new Response(JSON.stringify(200 === status ? replies.shift() : {}), { status }),
      );
    };
    return { asks, fetch };
  };
  const run = (fetch: (url: string, init: RequestInit) => Promise<Response>, slept: number[]) =>
    start({
      fetch,
      prepare: () =>
        Promise.resolve({
          sessionId: 'tab-1',
          applied: { target: 'tab', mode: 'platform', sessionId: 'tab-1' },
          ignored: [],
        }),
      session: () => ({ invoke: () => Promise.resolve({ ok: true }) }),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      now: () => 0,
    }).tick();

  it('asks again, the same ask, after a dropped connection and a 503, then carries on', async () => {
    const s = session(
      [200, 'drop', 503, 200],
      [{ calls: [{ seq: 1, tool: 'reticle_look', args: {} }] }, { done: true }],
    );
    const slept: number[] = [];
    await run(s.fetch, slept);
    expect(s.asks.map((a) => a.ask)).toEqual([0, 1, 1, 1]);
    // The resend carried the same results: the platform answers the ask once.
    expect(s.asks[1]?.results).toEqual(s.asks[3]?.results);
    expect(slept).toEqual([500, 1000]);
  });

  it('stops at once when the platform refuses the ask, and gives up after its retries', async () => {
    const refused = session([409], []);
    await run(refused.fetch, []);
    expect(refused.asks).toHaveLength(1);
    const down = session(['drop', 'drop', 'drop', 'drop', 'drop'], []);
    const slept: number[] = [];
    await run(down.fetch, slept);
    expect(down.asks).toHaveLength(5);
    expect(slept).toEqual([500, 1000, 2000, 4000]);
  });
});
