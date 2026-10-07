import { afterEach, describe, expect, it } from 'vitest';
import { LinkCapability, PLATFORM_LINK_VERSION } from '@reticlehq/core';
import {
  appKeyOf,
  appsByPlatform,
  machineOf,
  nameFromProjectId,
  pickAppTab,
  startAppReports,
  type AppReports,
  type AppTab,
  mayOpen,
} from './local-apps.js';

const A = { url: 'https://p.test', apiKey: 'key-a' };
const B = { url: 'https://p.test', apiKey: 'key-b' };
const MACHINE = machineOf('devs-mbp.local', '/Users/dev');

const tab = (sessionId: string, url: string, extra: Partial<AppTab> = {}): AppTab => ({
  sessionId,
  url,
  adapters: ['react'],
  hidden: false,
  lastSeenMs: 0,
  ...extra,
});

let running: AppReports | undefined;
afterEach(() => running?.stop());

describe('which app is which', () => {
  it("names an app by its project's id, without the hash, when nothing better is known", () => {
    expect(nameFromProjectId('reticlehq-example-react-fba80ab0')).toBe('reticlehq-example-react');
    expect(nameFromProjectId('plain')).toBe('plain');
  });

  it('names the machine without its .local suffix, and keeps its id stable', () => {
    expect(MACHINE.name).toBe('devs-mbp');
    expect(machineOf('devs-mbp.local', '/Users/dev').id).toBe(MACHINE.id);
  });

  it('gives two projects on the same port two keys, and one project the same key on any port', () => {
    expect(appKeyOf(MACHINE.id, '/code/shop', 'p')).not.toBe(
      appKeyOf(MACHINE.id, '/code/admin', 'p'),
    );
    expect(appKeyOf(MACHINE.id, '/code/shop', 'p')).toBe(appKeyOf(MACHINE.id, '/code/shop', 'p'));
  });
});

describe('the apps reported to each platform', () => {
  const dirs: Record<string, string> = { s1: '/code/shop', s2: '/code/admin', s3: '/code/shop' };
  const describeTab = (t: AppTab) =>
    Promise.resolve({
      platform: 's2' === t.sessionId ? B : A,
      dir: dirs[t.sessionId] ?? '/',
      name: (dirs[t.sessionId] ?? '/').split('/').pop() ?? '',
    });

  it('reports each project once, to the platform its link names, with what it is built with', async () => {
    const groups = await appsByPlatform(
      [
        tab('s1', 'http://localhost:3000/cart', { title: 'Shop', runtime: 'web' }),
        tab('s2', 'http://localhost:3000/', { adapters: ['vue'], runtime: 'electron' }),
        tab('s3', 'http://localhost:3000/other', { hidden: true }),
      ],
      undefined,
      MACHINE.id,
      describeTab,
    );
    expect(groups).toEqual([
      {
        platform: A,
        apps: [
          {
            key: appKeyOf(MACHINE.id, '/code/shop', undefined),
            name: 'shop',
            url: 'http://localhost:3000/cart',
            title: 'Shop',
            stack: ['react'],
          },
        ],
      },
      {
        platform: B,
        apps: [
          {
            key: appKeyOf(MACHINE.id, '/code/admin', undefined),
            name: 'admin',
            url: 'http://localhost:3000/',
            stack: ['vue', 'electron'],
          },
        ],
      },
    ]);
  });

  /**
   * Found driving it: a daemon that cannot map a project to its checkout files it under one shared
   * `~/.reticle/unmatched` directory, so keyed by directory alone every such project was one app.
   */
  it('keeps two projects apart even when neither could be mapped to its checkout', async () => {
    const unmatched = (t: AppTab) =>
      Promise.resolve({
        platform: A,
        dir: '/home/.reticle/unmatched',
        name: `${t.projectId ?? ''}`,
      });
    const groups = await appsByPlatform(
      [
        tab('s1', 'http://localhost:3000/', { projectId: 'shop-1a2b3c4d' }),
        tab('s2', 'http://localhost:3000/', { projectId: 'admin-5e6f7a8b' }),
      ],
      undefined,
      MACHINE.id,
      unmatched,
    );
    expect(new Set(groups[0]?.apps.map((a) => a.key)).size).toBe(2);
  });

  it("reports an app's address without the marks Reticle put on it", async () => {
    const groups = await appsByPlatform(
      [tab('s1', 'http://localhost:5301/cart?q=1&__reticle_session=lease-1&__reticle_project=p')],
      undefined,
      MACHINE.id,
      describeTab,
    );
    expect(groups[0]?.apps[0]?.url).toBe('http://localhost:5301/cart?q=1');
  });

  it('still reports to the linked platform with no app open, so the chat knows the machine is there', async () => {
    expect(await appsByPlatform([], A, MACHINE.id, describeTab)).toEqual([
      { platform: A, apps: [] },
    ]);
  });

  it('leaves out a tab of a project that is not linked', async () => {
    const groups = await appsByPlatform(
      [tab('s1', 'http://localhost:3000/')],
      undefined,
      MACHINE.id,
      () => Promise.resolve({ dir: '/code/x', name: 'x' }),
    );
    expect(groups).toEqual([]);
  });
});

describe('reporting', () => {
  const platform = (answer: unknown) => {
    const calls: { url: string; body: unknown; auth: string | undefined }[] = [];
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      calls.push({
        url,
        body: JSON.parse('string' === typeof init.body ? init.body : '{}') as unknown,
        auth: (init.headers as Record<string, string>)['authorization'],
      });
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    };
    return { calls, fetch };
  };
  const shop = { key: 'k_shop', name: 'shop', url: 'http://localhost:3000/', stack: [] };

  it('sends the machine, its version and its apps, and opens an app it was asked to wake', async () => {
    const p = platform({
      wake: [{ key: 'k_admin', url: 'http://localhost:4000/' }],
      pendingDrive: false,
    });
    const opened: string[] = [];
    running = startAppReports({
      machine: MACHINE,
      version: '3.6.1',
      capabilities: [LinkCapability.DRIVE_SPEC],
      apps: () => Promise.resolve([{ platform: A, apps: [shop] }]),
      open: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
      drivePending: () => undefined,
      fetch: p.fetch,
      intervalMs: 60_000,
    });
    await running.tick();
    expect(p.calls[0]).toEqual({
      url: 'https://p.test/v1/harness/local-apps',
      body: {
        machine: MACHINE,
        reticleVersion: '3.6.1',
        protocol: PLATFORM_LINK_VERSION,
        capabilities: [LinkCapability.DRIVE_SPEC],
        apps: [shop],
      },
      auth: 'Bearer key-a',
    });
    expect(opened).toEqual(['http://localhost:4000/']);
  });

  it('never re-opens an app that is already open, and says when a drive is waiting', async () => {
    const p = platform({ wake: [{ key: 'k_shop', url: shop.url }], pendingDrive: true });
    const opened: string[] = [];
    const pending: string[] = [];
    running = startAppReports({
      machine: MACHINE,
      version: '3.6.1',
      capabilities: [LinkCapability.DRIVE_SPEC],
      apps: () => Promise.resolve([{ platform: A, apps: [shop] }]),
      open: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
      drivePending: (to) => pending.push(to.apiKey),
      fetch: p.fetch,
      intervalMs: 60_000,
    });
    await running.tick();
    expect(opened).toEqual([]);
    expect(pending).toEqual(['key-a']);
  });

  it('shrugs off a platform that is down', async () => {
    running = startAppReports({
      machine: MACHINE,
      version: '3.6.1',
      capabilities: [LinkCapability.DRIVE_SPEC],
      apps: () => Promise.resolve([{ platform: A, apps: [] }]),
      open: () => Promise.resolve(),
      drivePending: () => undefined,
      fetch: () => Promise.reject(new Error('offline')),
      intervalMs: 60_000,
    });
    await expect(running.tick()).resolves.toBeUndefined();
  });
});

describe('the tab a drive attached to an app uses', () => {
  const keyOf = (id: string): string | undefined => ({ s1: 'k_shop', s2: 'k_admin' })[id];

  it('drives only that app, never another on the same port', async () => {
    const tabs = [tab('s1', 'http://localhost:3000/'), tab('s2', 'http://localhost:3000/')];
    expect(
      await pickAppTab(
        { key: 'k_admin', url: null },
        'x',
        () => tabs,
        keyOf,
        () => Promise.resolve(),
        0,
      ),
    ).toBe('s2');
  });

  it('opens the app when no tab of it is open, then drives the tab it opened', async () => {
    const tabs: AppTab[] = [];
    const opened: string[] = [];
    const picked = await pickAppTab(
      { key: 'k_shop', url: 'http://localhost:3000/' },
      'x',
      () => tabs,
      keyOf,
      (url) => {
        opened.push(url);
        tabs.push(tab('s1', url));
        return Promise.resolve();
      },
      1_000,
    );
    expect(opened).toEqual(['http://localhost:3000/']);
    expect(picked).toBe('s1');
  });

  it('refuses when the app is not open and nothing says where it lives', async () => {
    expect(
      await pickAppTab(
        { key: 'k_shop', url: null },
        'x',
        () => [],
        keyOf,
        () => Promise.resolve(),
        0,
      ),
    ).toBeNull();
  });
});

describe('an address the platform asks this machine to open', () => {
  it('is a web page here, or on an app already open, and nothing else', () => {
    const open = ['https://staging.example.com/cart'];
    expect(mayOpen('http://localhost:5173/', [])).toBe(true);
    expect(mayOpen('http://127.0.0.1:3000/a', [])).toBe(true);
    expect(mayOpen('https://staging.example.com/login', open)).toBe(true);
    expect(mayOpen('file:///etc/passwd', open)).toBe(false);
    expect(mayOpen('http://10.0.0.5/admin', open)).toBe(false);
    expect(mayOpen('https://evil.example.com/', open)).toBe(false);
    expect(mayOpen('not a url', open)).toBe(false);
  });
});

describe('what the platform tells the person', () => {
  it('shows each notice once, however often the platform repeats it', async () => {
    const notice = { level: 'update', text: 'Run reticle update to drive with every option.' };
    const fetch = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ wake: [], notices: [notice, { level: 'x' }] })),
      );
    const shown: unknown[] = [];
    running = startAppReports({
      machine: MACHINE,
      version: '3.6.1',
      capabilities: [],
      apps: () => Promise.resolve([{ platform: A, apps: [] }]),
      open: () => Promise.resolve(),
      drivePending: () => undefined,
      notify: (n, to) => shown.push([n, to.apiKey]),
      fetch,
      intervalMs: 60_000,
    });
    await running.tick();
    await running.tick();
    expect(shown).toEqual([[notice, 'key-a']]);
  });
});
