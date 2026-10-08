import { describe, expect, it } from 'vitest';
import { DriveStoppedError, runHarness, type HarnessToolset } from '../harness.js';
import {
  DRIVE_HEADER,
  platformHeaders,
  serverDriver,
  serverOptionsFromEnv,
} from './server-driver.js';

const toolset = (seen: string[]): HarnessToolset => ({
  tools: [{ name: 'reticle_act_and_wait', description: 'act', inputSchema: { type: 'object' } }],
  invoke: (name, args) => {
    seen.push(`${name}:${JSON.stringify(args)}`);
    return Promise.resolve({ verified: 'yes' });
  },
});

function platform(script: Record<string, (body: Record<string, unknown>) => unknown>) {
  const asked: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    asked.push({ path, body });
    const answer = (script[path] ?? (() => ({ status: 404 })))(body);
    const status = (answer as { status?: number }).status;
    return Promise.resolve(
      'number' === typeof status
        ? new Response('{}', { status })
        : new Response(JSON.stringify(answer), { status: 200 }),
    );
  };
  return { asked, fetch };
}

describe('the platform drives, this machine executes', () => {
  it('starts a run, executes each call the platform chooses, and reports the outcomes back', async () => {
    const { asked, fetch } = platform({
      '/v1/harness/runs': () => ({ runId: 'hr_1' }),
      '/v1/harness/runs/hr_1/turn': (body) =>
        0 === body['turn']
          ? {
              turn: 0,
              calls: [{ id: 't1', name: 'reticle_act_and_wait', args: { ref: 'e1' } }],
              text: 'clicking',
              done: false,
              status: 'running',
            }
          : {
              turn: 1,
              calls: [],
              text: 'ok',
              done: true,
              status: 'finished',
              summary: 'proved',
              // As the platform does: a replayed reply (any later turn) carries no spend.
              ...(1 === body['turn']
                ? { usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 0 } }
                : {}),
            },
    });
    const executed: string[] = [];
    const result = await runHarness(
      serverDriver({ url: 'https://p.test', apiKey: 'rk_live_x', persona: 'a shopper', fetch }),
      toolset(executed),
    );
    expect(executed).toEqual(['reticle_act_and_wait:{"ref":"e1"}']);
    expect(result.stopReason).toBe('finished');
    expect(result.summary).toBe('proved');
    expect(result.usage).toEqual({ input: 10, output: 2, cacheRead: 5, cacheWrite: 0 });
    expect(asked[0]?.body).toMatchObject({ persona: 'a shopper' });
    // The second turn carried exactly the outcome of the call it was asked to make.
    expect(asked[2]?.body).toMatchObject({
      turn: 1,
      outcomes: [{ id: 't1', name: 'reticle_act_and_wait', result: { verified: 'yes' } }],
    });
  });

  /** The Harness decides on the platform; a password it types must never travel there. */
  it('sends a secret field by name only, and fills in its value on this machine', async () => {
    const { asked, fetch } = platform({
      '/v1/harness/runs': () => ({ runId: 'hr_1' }),
      '/v1/harness/runs/hr_1/turn': (body) =>
        0 === body['turn']
          ? {
              turn: 0,
              calls: [
                {
                  id: 't1',
                  name: 'reticle_act_and_wait',
                  args: {
                    ref: 'e6',
                    action: 'fill',
                    args: { value: 'reticle-secret:auth-password' },
                  },
                },
              ],
              text: 'signing in',
              done: false,
              status: 'running',
            }
          : { turn: 1, calls: [], text: 'ok', done: true, status: 'finished', summary: 'in' },
    });
    const executed: string[] = [];
    await runHarness(
      serverDriver({
        url: 'https://p.test',
        apiKey: 'k',
        fetch,
        env: { RETICLE_SECRET_AUTH_PASSWORD: 'hunter2' },
      }),
      toolset(executed),
    );
    expect(executed[0]).toContain('hunter2');
    expect(asked[0]?.body['secrets']).toEqual(['AUTH_PASSWORD']);
    expect(JSON.stringify(asked)).not.toContain('hunter2');
  });

  it('says why the platform refused', async () => {
    const { fetch } = platform({ '/v1/harness/runs': () => ({ status: 402 }) });
    const result = await runHarness(
      serverDriver({
        url: 'https://p.test',
        apiKey: 'k',
        fetch,
      }),
      toolset([]),
    );
    expect(result.stopReason).toBe('broken');
    expect(result.error).toContain('402');
  });
});

describe('autonomous driving switched off mid-run', () => {
  it('ends the drive as stopped, not broken', async () => {
    const answers = [
      { status: 201, body: { runId: 'hr_1' } },
      { status: 409, body: { error: { code: 'harness_off', message: 'switched off' } } },
    ];
    const driver = serverDriver({
      url: 'https://p.test',
      apiKey: 'k',
      fetch: () => {
        const next = answers.shift() ?? { status: 500, body: {} };
        return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
      },
    });
    await expect(driver.turn({ system: '', tools: [], history: [] })).rejects.toBeInstanceOf(
      DriveStoppedError,
    );
  });
});

describe('a free drive names itself on every call', () => {
  it('reads the drive id from the environment and sends it as a header on each turn', async () => {
    const headers: string[] = [];
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      headers.push(String(new Headers(init.headers).get(DRIVE_HEADER)));
      const done = new URL(url).pathname.endsWith('/turn');
      return Promise.resolve(
        new Response(
          JSON.stringify(
            done
              ? { turn: 0, calls: [], text: '', done: true, status: 'finished' }
              : { runId: 'hr_free' },
          ),
          { status: 200 },
        ),
      );
    };
    const platform = serverOptionsFromEnv({
      RETICLE_API_KEY: 'rk_live_x',
      RETICLE_CLOUD_URL: 'https://p.test',
      RETICLE_DRIVE_ID: 'drv_1',
    });
    expect(platform?.driveId).toBe('drv_1');
    if (platform === undefined) return;
    await runHarness(serverDriver({ ...platform, fetch }), toolset([]));
    expect(headers.length).toBeGreaterThan(1);
    expect(new Set(headers)).toEqual(new Set(['drv_1']));
  });

  it('sends no drive header when no free drive was granted', () => {
    expect(platformHeaders({ apiKey: 'k' })[DRIVE_HEADER]).toBeUndefined();
  });
});
