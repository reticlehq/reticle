import { describe, expect, it } from 'vitest';
import { EventType, NetInitiator, type ReticleEvent } from '@reticlehq/core';
import { OnboardingStop } from '@reticlehq/core/telemetry';
import {
  AppChoice,
  MAX_LINKS_OPENED,
  bareRunsFirstVerdict,
  chooseApp,
  judgeSmoke,
  linksToOpen,
  pageFactsOf,
  runFirstVerdict,
  type FirstVerdictPorts,
  type PageFacts,
  type SmokeFacts,
} from './first-verdict.js';

const APP = 'http://localhost:5173/';

let seq = 0;
function event(type: string, data: Record<string, unknown>, documentId = 'doc-2'): ReticleEvent {
  seq += 1;
  return { t: seq, type, sessionId: 's1', documentId, data } as ReticleEvent;
}
const documentLoad = (status: number, documentId = 'doc-2'): ReticleEvent =>
  event(
    EventType.NET_REQUEST,
    { url: APP, status, ok: status < 400, initiator: NetInitiator.DOCUMENT },
    documentId,
  );

const cleanPage = (url: string): PageFacts => ({
  url,
  arrived: true,
  documentStatus: 200,
  consoleErrors: [],
  failedRequests: [],
});

describe('bare reticle runs the first verdict only in a folder Reticle has not wired', () => {
  it('runs it for a bare command in an unwired folder', () => {
    expect(bareRunsFirstVerdict([], false)).toBe(true);
  });
  it('keeps `serve` in a wired project', () => {
    expect(bareRunsFirstVerdict([], true)).toBe(false);
  });
  it('keeps every explicit subcommand as it was', () => {
    expect(bareRunsFirstVerdict(['serve'], false)).toBe(false);
    expect(bareRunsFirstVerdict(['verify', APP], false)).toBe(false);
  });
});

describe('which app the first verdict checks', () => {
  it('uses the app folder pinned port when it already serves', () => {
    expect(chooseApp({ devCommand: { port: 3001 }, pinnedServing: true, running: [5173] })).toEqual(
      { action: AppChoice.USE, url: 'http://localhost:3001' },
    );
  });
  it('starts the app folder dev command when its server does not serve, and never takes another app', () => {
    expect(chooseApp({ devCommand: {}, pinnedServing: false, running: [5173] })).toEqual({
      action: AppChoice.START,
    });
  });
  it('uses the one dev server that runs, outside an app folder', () => {
    expect(chooseApp({ pinnedServing: false, running: [5173] })).toEqual({
      action: AppChoice.USE,
      url: 'http://localhost:5173',
    });
  });
  it('does not guess between several running servers', () => {
    const choice = chooseApp({ pinnedServing: false, running: [3000, 5173] });
    expect(choice.action).toBe(AppChoice.NONE);
    if (AppChoice.NONE === choice.action) {
      expect(choice.lines.join('\n')).toContain('http://localhost:3000');
      expect(choice.lines.join('\n')).toContain('http://localhost:5173');
    }
  });
  it('stops with no_web_app when there is no app and nothing runs', () => {
    const choice = chooseApp({ pinnedServing: false, running: [] });
    expect(choice).toMatchObject({ action: AppChoice.NONE, stop: OnboardingStop.NO_WEB_APP });
  });
});

describe('what one page did, from its own document', () => {
  it('reads the document status, console errors and failed requests of the current document only', () => {
    const events = [
      event(EventType.CONSOLE_ERROR, { message: 'old document' }, 'doc-1'),
      documentLoad(200),
      event(EventType.CONSOLE_ERROR, { message: 'boom' }),
      event(EventType.ERROR_UNCAUGHT, { message: 'TypeError: x is undefined' }),
      event(EventType.NET_REQUEST, {
        method: 'GET',
        url: 'http://localhost:5173/api/a',
        status: 500,
      }),
      event(EventType.NET_REQUEST, {
        method: 'GET',
        url: 'http://localhost:5173/api/b',
        status: 200,
      }),
      event(EventType.NET_REQUEST, {
        method: 'POST',
        url: 'http://localhost:5173/api/c',
        status: 0,
        error: 'Failed to fetch',
      }),
    ];
    expect(pageFactsOf(APP, events, { arrived: true })).toEqual({
      url: APP,
      arrived: true,
      documentStatus: 200,
      consoleErrors: ['boom', 'TypeError: x is undefined'],
      failedRequests: [
        'GET http://localhost:5173/api/a: HTTP 500',
        'POST http://localhost:5173/api/c: Failed to fetch',
      ],
    });
  });
  it('does not count a request the page cancelled as a failure', () => {
    const events = [
      documentLoad(200),
      event(EventType.NET_REQUEST, {
        method: 'GET',
        url: 'http://localhost:5173/api/slow',
        status: 0,
        error: 'AbortError: The user aborted a request.',
      }),
    ];
    expect(pageFactsOf(APP, events, { arrived: true }).failedRequests).toEqual([]);
  });
  it('keeps where the page landed when it is not the url asked for', () => {
    expect(
      pageFactsOf(APP, [documentLoad(200)], {
        arrived: false,
        landedOn: 'http://localhost:5173/login',
      }),
    ).toMatchObject({ arrived: false, landedOn: 'http://localhost:5173/login' });
  });
});

describe('which links the smoke check opens', () => {
  const links = [
    { name: 'Home', href: '/' },
    { name: 'About', href: '/about' },
    { name: 'About again', href: '/about#team' },
    { name: 'Docs', href: 'https://docs.example.com/' },
    { name: 'Mail', href: 'mailto:a@b.c' },
    { name: 'Sign out', href: '/logout' },
    { name: 'Pricing', href: 'pricing?plan=pro' },
  ];
  it('opens each same-origin page once, and never one that ends the session', () => {
    expect(linksToOpen(APP, links)).toEqual({
      open: ['http://localhost:5173/about', 'http://localhost:5173/pricing?plan=pro'],
      found: 2,
    });
  });
  it('says how many it found when it opens fewer', () => {
    const many = Array.from({ length: MAX_LINKS_OPENED + 3 }, (_, i) => ({
      name: `Page ${String(i)}`,
      href: `/p${String(i)}`,
    }));
    const picked = linksToOpen(APP, many);
    expect(picked.open).toHaveLength(MAX_LINKS_OPENED);
    expect(picked.found).toBe(MAX_LINKS_OPENED + 3);
  });
});

describe('the smoke verdict', () => {
  const pass: SmokeFacts = {
    start: cleanPage(APP),
    links: [cleanPage('http://localhost:5173/about')],
    linksFound: 1,
  };
  it('passes a page that loads clean with links that open', () => {
    const verdict = judgeSmoke(pass);
    expect(verdict.verified).toBe('yes');
    expect(verdict.lines.at(-1)).toContain('verified: yes');
  });
  it('fails a page with a console error', () => {
    const verdict = judgeSmoke({
      ...pass,
      start: { ...cleanPage(APP), consoleErrors: ['boom'] },
    });
    expect(verdict.verified).toBe('no');
    expect(verdict.lines.join('\n')).toContain('boom');
  });
  it('fails a page with a failed request', () => {
    const verdict = judgeSmoke({
      ...pass,
      start: { ...cleanPage(APP), failedRequests: ['GET /api: HTTP 500'] },
    });
    expect(verdict.verified).toBe('no');
  });
  it('fails a page that answered with an error status', () => {
    expect(
      judgeSmoke({ ...pass, start: { ...cleanPage(APP), documentStatus: 500 } }).verified,
    ).toBe('no');
  });
  it('fails a page that never loaded', () => {
    expect(judgeSmoke({ ...pass, start: { ...cleanPage(APP), arrived: false } }).verified).toBe(
      'no',
    );
  });
  it('fails a link that does not open', () => {
    const verdict = judgeSmoke({
      ...pass,
      links: [{ ...cleanPage('http://localhost:5173/about'), documentStatus: 404 }],
    });
    expect(verdict.verified).toBe('no');
    expect(verdict.lines.join('\n')).toContain('/about');
  });
  it('says so when it opened fewer links than it found', () => {
    expect(judgeSmoke({ ...pass, linksFound: 12 }).lines.join('\n')).toContain('1 of 12');
  });
  it('calls a sign-in page a verdict up to there', () => {
    const verdict = judgeSmoke({
      ...pass,
      start: { ...cleanPage(APP), arrived: false, landedOn: 'http://localhost:5173/login' },
    });
    expect(verdict.verified).toBe('yes');
    expect(verdict.lines.join('\n')).toContain('sign-in');
  });
});

describe('runFirstVerdict', () => {
  function ports(over: Partial<FirstVerdictPorts>): {
    ports: FirstVerdictPorts;
    out: string[];
    stops: OnboardingStop[];
    stopped: string[];
  } {
    const out: string[] = [];
    const stops: OnboardingStop[] = [];
    const stopped: string[] = [];
    return {
      out,
      stops,
      stopped,
      ports: {
        findApp: () => Promise.resolve({ url: APP }),
        smoke: () =>
          Promise.resolve({ start: cleanPage(APP), links: [], linksFound: 0 } as SmokeFacts),
        out: (line) => out.push(line),
        stop: (row) => stops.push(row.stop),
        ...over,
      },
    };
  }

  it('prints a passing verdict and the next step, and exits 0', async () => {
    const p = ports({});
    expect(await runFirstVerdict(p.ports)).toBe(0);
    expect(p.out.join('\n')).toContain('verified: yes');
    expect(p.out.join('\n')).toContain('init');
  });
  it('exits 1 on a failing page', async () => {
    const p = ports({
      smoke: () =>
        Promise.resolve({
          start: { ...cleanPage(APP), consoleErrors: ['boom'] },
          links: [],
          linksFound: 0,
        }),
    });
    expect(await runFirstVerdict(p.ports)).toBe(1);
    expect(p.out.join('\n')).toContain('verified: no');
  });
  it('records the stop when no app is found', async () => {
    const p = ports({
      findApp: () => Promise.resolve({ lines: ['no app'], stop: OnboardingStop.NO_WEB_APP }),
    });
    expect(await runFirstVerdict(p.ports)).toBe(1);
    expect(p.stops).toEqual([OnboardingStop.NO_WEB_APP]);
  });
  it('records app_not_connected when the page cannot be opened', async () => {
    const p = ports({ smoke: () => Promise.resolve({ failed: ['could not open'] }) });
    expect(await runFirstVerdict(p.ports)).toBe(1);
    expect(p.stops).toEqual([OnboardingStop.APP_NOT_CONNECTED]);
  });
  it('stops the dev server it started, whatever the verdict', async () => {
    const p = ports({});
    const withServer = ports({
      findApp: () => Promise.resolve({ url: APP, release: () => p.stopped.push('dev') }),
      smoke: () => Promise.reject(new Error('lost the daemon')),
    });
    expect(await runFirstVerdict(withServer.ports)).toBe(1);
    expect(p.stopped).toEqual(['dev']);
  });
});
