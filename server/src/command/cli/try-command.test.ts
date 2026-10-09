import { describe, expect, it } from 'vitest';
import {
  MSG_SIGN_IN_FIRST,
  journeysOf,
  parseTryArgs,
  requestFreeDrive,
  runTry,
  summarizeTry,
  type FreeDrive,
  type TryDrive,
  type TryFetch,
  type TryPorts,
} from './try-command.js';

const CLOUD = { url: 'https://app.reticle.test', apiKey: 'rk_live_x' };
const URL_UNDER_TEST = 'https://shop.example';

interface Seen {
  out: string[];
  fail: string[];
  drives: { url: string; driveId: string; persona?: string }[];
  synced: number;
}

function ports(over: { linked?: boolean; grant?: FreeDrive; drive?: TryDrive; sync?: boolean }): {
  ports: TryPorts;
  seen: Seen;
} {
  const seen: Seen = { out: [], fail: [], drives: [], synced: 0 };
  return {
    seen,
    ports: {
      linked: () => Promise.resolve(false === over.linked ? null : CLOUD),
      requestDrive: () => Promise.resolve(over.grant ?? { granted: true, driveId: 'drv_1' }),
      drive: (request) => {
        seen.drives.push(request);
        return Promise.resolve(over.drive ?? { journeys: [], runIds: [] });
      },
      sync: () => {
        seen.synced += 1;
        return Promise.resolve(over.sync ?? true);
      },
      dashboardUrl: () => Promise.resolve('https://app.reticle.test/p/shop'),
      out: (line) => seen.out.push(line),
      fail: (line) => seen.fail.push(line),
    },
  };
}

describe('reticle try', () => {
  it('asks a machine that is not linked to sign in, and drives nothing', async () => {
    const { ports: p, seen } = ports({ linked: false });
    expect(await runTry({ url: URL_UNDER_TEST }, p)).toBe(1);
    expect(seen.fail).toEqual([MSG_SIGN_IN_FIRST]);
    expect(MSG_SIGN_IN_FIRST).toBe('Sign in first: reticle connect (it is free, no card)');
    expect(seen.drives).toEqual([]);
  });

  it('prints the platform message and the plan page when it wants a card, and drives nothing', async () => {
    const { ports: p, seen } = ports({
      grant: {
        granted: false,
        needsCard: true,
        message: 'Your free drives are used up.',
        hint: 'Add a card to keep driving.',
      },
    });
    expect(await runTry({ url: URL_UNDER_TEST }, p)).toBe(1);
    expect(seen.fail).toEqual([
      'Your free drives are used up.',
      'Add a card to keep driving.',
      'Plans: https://app.reticle.test/settings?group=billing',
    ]);
    expect(seen.drives).toEqual([]);
  });

  it('drives with the granted id and the persona, then lists every journey and where it was saved', async () => {
    const { ports: p, seen } = ports({
      drive: {
        runIds: ['harness-1'],
        journeys: [
          { title: 'Shopper: checks out', status: 'passed' },
          { title: 'Shopper: applies a coupon', status: 'failed' },
          { title: 'Admin: refunds', status: 'blocked' },
          { title: 'Guest branch', status: 'not-taken' },
        ],
      },
    });
    expect(await runTry({ url: URL_UNDER_TEST, persona: 'a shopper' }, p)).toBe(0);
    expect(seen.drives).toEqual([{ url: URL_UNDER_TEST, driveId: 'drv_1', persona: 'a shopper' }]);
    expect(seen.out.slice(1)).toEqual([
      'Tried 3 journeys: 1 work, 1 broken, 1 not proved',
      '  ✓ works: Shopper: checks out',
      '  ✗ broken: Shopper: applies a coupon',
      '  ? not proved (blocked): Admin: refunds',
      'See it in your dashboard: https://app.reticle.test/runs/harness-1',
    ]);
  });

  it('never claims the run was saved when the sync failed', async () => {
    const { ports: p, seen } = ports({ sync: false, drive: { journeys: [], runIds: [] } });
    expect(await runTry({ url: URL_UNDER_TEST }, p)).toBe(0);
    expect(seen.out.some((line) => line.startsWith('Saved to your dashboard'))).toBe(false);
    expect(seen.fail.join('\n')).toContain('reticle push');
  });

  it('reports a drive that could not run, and syncs nothing', async () => {
    const { ports: p, seen } = ports({
      drive: { journeys: [], runIds: [], error: 'the lease never connected' },
    });
    expect(await runTry({ url: URL_UNDER_TEST }, p)).toBe(1);
    expect(seen.fail).toEqual(['the lease never connected']);
    expect(seen.synced).toBe(0);
  });
});

describe('summarizeTry', () => {
  it('counts one journey in the singular, and running as not proved rather than working', () => {
    expect(summarizeTry([{ title: 'a', status: 'running' }])[0]).toBe(
      'Tried 1 journey: 0 work, 0 broken, 1 not proved',
    );
  });
});

describe('journeysOf', () => {
  it('reads the plan journeys when the report carries them', () => {
    expect(journeysOf({ journeys: [{ title: 'x', status: 'passed' }, { bad: 1 }] })).toEqual([
      { title: 'x', status: 'passed' },
    ]);
  });

  it('grades an unplanned drive from its goal, and never rounds an unproved one up', () => {
    expect(journeysOf({ proved: true, goalMet: false }, 'p')).toEqual([
      { title: 'p', status: 'failed' },
    ]);
    expect(journeysOf({ proved: true })[0]?.status).toBe('passed');
    expect(journeysOf({ proved: false })[0]?.status).toBe('blocked');
  });
});

describe('parseTryArgs', () => {
  it('takes a url and an optional persona, and refuses anything else', () => {
    expect(parseTryArgs(['https://a', '--persona', 'a buyer'])).toEqual({
      url: 'https://a',
      persona: 'a buyer',
    });
    expect(parseTryArgs([])).toHaveProperty('error');
    expect(parseTryArgs(['https://a', '--persona'])).toHaveProperty('error');
    expect(parseTryArgs(['https://a', '--port', '1'])).toHaveProperty('error');
  });
});

describe('requestFreeDrive', () => {
  const answering =
    (status: number, body: unknown, seen: { url?: string; init?: unknown } = {}): TryFetch =>
    (url, init) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
    };

  it('posts kind "try" with the key and returns the granted drive', async () => {
    const seen: { url?: string; init?: unknown } = {};
    const grant = await requestFreeDrive(
      CLOUD,
      answering(200, { granted: true, driveId: 'drv_9' }, seen),
    );
    expect(grant).toEqual({ granted: true, driveId: 'drv_9' });
    expect(seen.url).toBe('https://app.reticle.test/v1/harness/free-drive');
    expect(seen.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ kind: 'try' }),
      headers: { authorization: 'Bearer rk_live_x' },
    });
  });

  it('reads a 402 as needing a card, with the platform message', async () => {
    expect(
      await requestFreeDrive(
        CLOUD,
        answering(402, {
          error: 'needs_card',
          capability: 'harness',
          message: 'Add a card.',
          hint: 'h',
        }),
      ),
    ).toEqual({ granted: false, needsCard: true, message: 'Add a card.', hint: 'h' });
  });

  it('turns an unreachable platform into an answer rather than a throw', async () => {
    const grant = await requestFreeDrive(CLOUD, () => Promise.reject(new Error('offline')));
    expect(grant).toMatchObject({ granted: false, needsCard: false });
  });
});
