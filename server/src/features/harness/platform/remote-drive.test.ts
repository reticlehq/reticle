import { afterEach, describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import {
  REMOTE_DRIVE_ENDED,
  driveVerdict,
  endDrivenTab,
  pickDriveSession,
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
      body: { ok: true, summary: '1 of 1 proved' },
    });
  });

  it('reports a drive that threw as failed, in its own words', async () => {
    const p = platform({ id: 'ld_2', goal: 'x' });
    await start({ fetch: p.fetch, drive: () => Promise.reject(new Error('not entitled')) }).tick();
    expect(p.calls[1]?.body).toEqual({ ok: false, summary: 'not entitled' });
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

  it('does not ask while no app is connected, so the chat can say so', async () => {
    const p = platform({ id: 'ld_3', goal: 'x' });
    await start({ fetch: p.fetch, connected: () => false }).tick();
    expect(p.calls).toHaveLength(0);
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
    await new Promise((resolve) => setTimeout(resolve, 60));
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
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await ticking;
    expect(driven).toEqual(['tab-2']);
    expect(new Set(filmed)).toEqual(new Set(['tab-2']));
  });
});

describe('the verdict a chat-requested drive reports', () => {
  it('is the goal judgement when the drive carries one', () => {
    expect(driveVerdict({ goalMet: false, proved: true })).toBe('no');
    // A journey whose goal was not reached is not "passed", so nothing reads proved: still a no.
    expect(driveVerdict({ goalMet: false, proved: false })).toBe('no');
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

  it('reads a quoted text missing from the final page as not proved, never as refuted', () => {
    // "goes from "Count is 0" to "Count is 1"": the drive ends on "Count is 1", so the start state is
    // rightly gone. The quoted texts are only looked for on the LAST page, so a miss cannot say which
    // state the person meant, and it marked a working counter "Failed". It still blocks a yes.
    const counter = [{ verified: 'no' }, { verified: 'yes' }];
    expect(
      driveVerdict({
        goalMet: true,
        proved: true,
        goals: counter,
        checks: { held: 1, failed: 0, undecided: 0 },
      }),
    ).toBe('unknown');
    expect(driveVerdict({ goalMet: true, proved: true, goals: counter })).toBe('unknown');
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
