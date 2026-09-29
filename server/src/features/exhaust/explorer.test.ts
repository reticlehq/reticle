import { describe, expect, it } from 'vitest';
import type { ReticleEvent } from '@reticlehq/core';
import { explore, type ExplorePort } from './explorer.js';
import { driveFailureBranches } from './failure-branches.js';

/*
 * A fake app with the shapes that made every earlier drive shallow: a login in front of everything,
 * a form that must be filled before its submit does anything, a receipt reachable only by paying,
 * and a table of twenty identical rows.
 */
interface Page {
  route: string;
  controls: { label: string; role: 'button' | 'link' | 'textbox' }[];
}
const PAGES: Record<string, Page> = {
  login: { route: '/login', controls: [{ label: 'Sign in', role: 'button' }] },
  dash: {
    route: '/dash',
    controls: [
      { label: 'Cart', role: 'link' },
      { label: 'Rows', role: 'link' },
    ],
  },
  cart: {
    route: '/cart',
    controls: [
      { label: 'Quantity', role: 'textbox' },
      { label: 'Pay', role: 'button' },
    ],
  },
  receipt: { route: '/receipt', controls: [{ label: 'Download receipt', role: 'button' }] },
  rows: {
    route: '/rows',
    controls: Array.from({ length: 20 }, (_, i) => ({
      label: `Delete row ${String(i + 1)}`,
      role: 'button' as const,
    })),
  },
};

function fakeApp(opts: { failPay?: boolean } = {}) {
  let page = 'login';
  let filled = false;
  let refSeq = 0;
  let refs = new Map<string, string>();
  const acted: string[] = [];
  let mocked = false;
  const at = (): Page => {
    const current = PAGES[page];
    if (current === undefined) throw new Error(`no page ${page}`);
    return current;
  };
  const tree = (): string => {
    refs = new Map();
    return at()
      .controls.map((c) => {
        refSeq += 1;
        const ref = `e${String(refSeq)}`;
        refs.set(ref, c.label);
        return `- ${c.role} "${c.label}" (ref=${ref})`;
      })
      .join('\n');
  };
  const port: ExplorePort = {
    reset: () => {
      page = 'login';
      filled = false;
      return Promise.resolve(true);
    },
    look: () => Promise.resolve({ tree: tree(), route: at().route }),
    act: (ref, action) => {
      const label = refs.get(ref);
      if (label === undefined) return Promise.resolve({ ok: false, events: [] });
      acted.push(`${action} ${label}`);
      const events: ReticleEvent[] = [];
      if ('fill' === action) filled = true;
      else if ('Sign in' === label) page = 'dash';
      else if ('Cart' === label) page = 'cart';
      else if ('Rows' === label) page = 'rows';
      else if ('Pay' === label && filled) {
        events.push({
          type: 'net.request',
          t: 1,
          data: { method: 'POST', url: 'http://h/api/pay', status: mocked ? 0 : 200 },
        } as unknown as ReticleEvent);
        if (!mocked || true !== opts.failPay) page = 'receipt';
      }
      return Promise.resolve({ ok: true, events });
    },
    mock: (rules) => {
      mocked = rules.length > 0;
      return Promise.resolve(true);
    },
  };
  return { port, acted };
}

describe('explore — a field that already holds a value is left alone', () => {
  it('does not type over pre-filled credentials', async () => {
    const typed: string[] = [];
    let page = 'login';
    const port: ExplorePort = {
      reset: () => {
        page = 'login';
        return Promise.resolve(true);
      },
      look: () =>
        Promise.resolve({
          route: `/${page}`,
          tree:
            'login' === page
              ? '- textbox "Email" (ref=e1) [value="admin@x.dev"]\n- button "Sign in" (ref=e2)'
              : '- button "Home" (ref=e3)',
        }),
      act: (ref, action, value) => {
        if ('fill' === action) typed.push(value ?? '');
        if ('e2' === ref) page = 'home';
        return Promise.resolve({ ok: true, events: [] });
      },
    };
    const report = await explore(port, { maxActions: 20, fillValue: () => 'placeholder' });
    expect(typed).toEqual([]);
    expect(report.routes).toContain('/home');
  });
});

describe('explore — the whole reachable app, not the first page', () => {
  it('gets past the login, fills the form, and reaches the page only paying reveals', async () => {
    const { port } = fakeApp();
    const report = await explore(port, { maxActions: 200, fillValue: () => '2' });
    expect(report.routes).toEqual(
      expect.arrayContaining(['/login', '/dash', '/cart', '/receipt', '/rows']),
    );
    expect(report.touched).toEqual(
      expect.arrayContaining(['button "Pay"', 'button "Download receipt"']),
    );
    expect(report.writes.map((w) => w.key)).toEqual(['POST /api/pay']);
    expect(report.frontier).toBe(0);
  });

  it('treats twenty identical rows as one control, so the table does not eat the budget', async () => {
    const { port, acted } = fakeApp();
    await explore(port, { maxActions: 200, fillValue: () => '2' });
    expect(acted.filter((a) => a.startsWith('click Delete row')).length).toBe(1);
  });

  it('stops at its budget and says how much is left', async () => {
    const { port } = fakeApp();
    const report = await explore(port, { maxActions: 3, fillValue: () => '2' });
    expect(report.frontier).toBeGreaterThan(0);
    expect(report.budgetExhausted).toBe(true);
  });
});

/*
 * `branched`: every write's FAILURE path, driven. The happy path is the one every drive already
 * takes; what a user meets when the server is down is the one nobody checks.
 */
describe('driveFailureBranches', () => {
  it('flags an app that shows success over a write that failed', async () => {
    const { port } = fakeApp({ failPay: false });
    const report = await explore(port, { maxActions: 200, fillValue: () => '2' });
    const branches = await driveFailureBranches(port, report.writes, { maxActions: 50 });
    expect(branches.branched).toEqual(['POST /api/pay']);
    expect(branches.unhandled.map((u) => u.key)).toEqual(['POST /api/pay']);
  });

  it('passes an app that stays put when the write fails', async () => {
    const { port } = fakeApp({ failPay: true });
    const report = await explore(port, { maxActions: 200, fillValue: () => '2' });
    const branches = await driveFailureBranches(port, report.writes, { maxActions: 50 });
    expect(branches.branched).toEqual(['POST /api/pay']);
    expect(branches.unhandled).toEqual([]);
  });

  /*
   * Found by driving the fixture: a panel whose add shows NOTHING on success looks the same when the
   * add fails, and the first oracle called that "claimed success". It claimed nothing. Equality with
   * the success state only accuses when success visibly moved the app.
   */
  it('does not accuse an app whose success is invisible too; it says the two cannot be told apart', async () => {
    const write = {
      key: 'POST /api/items',
      method: 'POST',
      urlPath: '/api/items',
      path: [{ key: 'button "Add item"', action: 'click' as const }],
      beforeState: 'S',
      successState: 'S',
    };
    const port: ExplorePort = {
      reset: () => Promise.resolve(true),
      look: () => Promise.resolve({ tree: '- button "Add item" (ref=e1)', route: '/d' }),
      act: () => Promise.resolve({ ok: true, events: [] }),
      mock: () => Promise.resolve(true),
    };
    const stateOfPage = 'S';
    const branches = await driveFailureBranches(port, [{ ...write, beforeState: stateOfPage }], {
      maxActions: 10,
    });
    expect(branches.unhandled).toEqual([]);
    expect(branches.indistinguishable).toEqual(['POST /api/items']);
  });

  it('says it could not, rather than passing, when nothing can break a request', async () => {
    const { port } = fakeApp();
    const report = await explore(port, { maxActions: 200, fillValue: () => '2' });
    const { mock: _mock, ...noMocks } = port;
    const branches = await driveFailureBranches(noMocks, report.writes, { maxActions: 50 });
    expect(branches.branched).toEqual([]);
    expect(branches.skipped).toMatch(/driven browser/);
  });
});
