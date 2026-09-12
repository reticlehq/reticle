import { describe, expect, it } from 'vitest';
import type { Page, Route } from 'playwright';
import { applyOutcome, installNetworkMocks, matchMock, type MockRule } from './network-mock.js';

describe('matchMock — pure rule resolution', () => {
  it('fulfills the first rule whose url substring matches, with defaults', () => {
    const rules: MockRule[] = [{ urlContains: '/api/pay', status: 500 }];
    expect(matchMock(rules, { url: 'https://app/api/pay', method: 'POST' })).toEqual({
      kind: 'fulfill',
      status: 500,
      contentType: 'application/json',
    });
  });

  it('continues when nothing matches (the request hits the real network)', () => {
    expect(matchMock([{ urlContains: '/api/pay' }], { url: '/api/cart', method: 'GET' })).toEqual({
      kind: 'continue',
    });
  });

  it('honors an optional case-insensitive method filter', () => {
    const rules: MockRule[] = [{ urlContains: '/api/pay', method: 'post', status: 402 }];
    expect(matchMock(rules, { url: '/api/pay', method: 'GET' }).kind).toBe('continue');
    expect(matchMock(rules, { url: '/api/pay', method: 'POST' }).status).toBe(402);
  });

  it('abort wins over a fulfilling status (simulated offline)', () => {
    expect(
      matchMock([{ urlContains: '/x', abort: true, status: 200 }], { url: '/x', method: 'GET' }),
    ).toEqual({
      kind: 'abort',
    });
  });

  it('first matching rule wins over a later one', () => {
    const rules: MockRule[] = [
      { urlContains: '/api', status: 503 },
      { urlContains: '/api/pay', status: 200 },
    ];
    expect(matchMock(rules, { url: '/api/pay', method: 'GET' }).status).toBe(503);
  });

  it('passes body + delay through on a fulfill', () => {
    const out = matchMock(
      [{ urlContains: '/x', status: 200, body: '{"ok":false}', delayMs: 250 }],
      { url: '/x', method: 'GET' },
    );
    expect(out.body).toBe('{"ok":false}');
    expect(out.delayMs).toBe(250);
  });
});

/** A fake Route recording which terminal method was called with what args. */
function recordingRoute(
  url: string,
  method: string,
): {
  route: Route;
  calls: { fn: string; arg?: unknown }[];
} {
  const calls: { fn: string; arg?: unknown }[] = [];
  const route = {
    request: () => ({ url: () => url, method: () => method }),
    continue: () => {
      calls.push({ fn: 'continue' });
      return Promise.resolve();
    },
    abort: (arg: string) => {
      calls.push({ fn: 'abort', arg });
      return Promise.resolve();
    },
    fulfill: (arg: unknown) => {
      calls.push({ fn: 'fulfill', arg });
      return Promise.resolve();
    },
  } as unknown as Route;
  return { route, calls };
}

describe('applyOutcome — drives a Route from an outcome', () => {
  it('fulfills with status/body/contentType and waits the delay first', async () => {
    const { route, calls } = recordingRoute('/api/pay', 'POST');
    const slept: number[] = [];
    await applyOutcome(
      route,
      { kind: 'fulfill', status: 500, body: 'boom', contentType: 'text/plain', delayMs: 30 },
      (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    );
    expect(slept).toEqual([30]);
    expect(calls).toEqual([
      { fn: 'fulfill', arg: { status: 500, contentType: 'text/plain', body: 'boom' } },
    ]);
  });

  it('aborts on an abort outcome', async () => {
    const { route, calls } = recordingRoute('/x', 'GET');
    await applyOutcome(route, { kind: 'abort' }, () => Promise.resolve());
    expect(calls).toEqual([{ fn: 'abort', arg: 'failed' }]);
  });

  it('continues on a continue outcome', async () => {
    const { route, calls } = recordingRoute('/x', 'GET');
    await applyOutcome(route, { kind: 'continue' }, () => Promise.resolve());
    expect(calls).toEqual([{ fn: 'continue' }]);
  });
});

/** A fake Page recording route/unroute registrations; lets the test fire the handler itself. */
function recordingPage(): {
  page: Page;
  registered: ((route: Route) => void) | undefined;
  unrouted: boolean;
  state: { handler?: (route: Route) => void; unrouted: boolean };
} {
  const state: { handler?: (route: Route) => void; unrouted: boolean } = { unrouted: false };
  const page = {
    unroute: () => {
      state.unrouted = true;
      return Promise.resolve();
    },
    route: (_pattern: string, handler: (route: Route) => void) => {
      state.handler = handler;
      return Promise.resolve();
    },
  } as unknown as Page;
  return {
    page,
    get registered() {
      return state.handler;
    },
    get unrouted() {
      return state.unrouted;
    },
    state,
  };
}

describe('installNetworkMocks — Playwright wiring', () => {
  it('clears prior routes and registers a handler that mocks a matching request', async () => {
    const fake = recordingPage();
    await installNetworkMocks(fake.page, [{ urlContains: '/api/pay', status: 500 }], () =>
      Promise.resolve(),
    );
    expect(fake.unrouted).toBe(true);
    expect(fake.state.handler).toBeDefined();

    const { route, calls } = recordingRoute('https://app/api/pay', 'POST');
    fake.state.handler?.(route);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls[0]?.fn).toBe('fulfill');
  });

  it('with an empty rule set, only clears prior routes (mocking off)', async () => {
    const fake = recordingPage();
    await installNetworkMocks(fake.page, [], () => Promise.resolve());
    expect(fake.unrouted).toBe(true);
    expect(fake.state.handler).toBeUndefined();
  });
});

/**
 * A delay with nothing to substitute must delay the REAL response, not invent an empty one.
 *
 * `delayMs` alone used to produce a `fulfill` — status 200, `application/json`, body `''`. That is
 * right for a fabricated failure and wrong for a slow endpoint: the app is handed an empty payload
 * it never asked for, so anything observed afterwards describes Reticle's fake rather than the app's
 * behaviour under load.
 *
 * It matters most for the thing this enables — seeded perturbation. A race "found" by pushing empty
 * bodies at an app is not a race, it is an artifact, and shipping that as a finding would put a
 * fabricated defect in front of somebody at 3am.
 *
 * So: a rule that says only WHEN says nothing about WHAT. The request goes to the real server and
 * the real answer comes back, later.
 */
describe('a delay with no substitute response delays the real one', () => {
  it('continues to the network rather than fulfilling an empty body', () => {
    const out = matchMock([{ urlContains: '/api/save', delayMs: 300 }], {
      url: 'https://app.test/api/save',
      method: 'POST',
    });
    expect(out.kind).toBe('continue');
    expect(out.delayMs).toBe(300);
  });

  it('still fulfills when the rule actually says WHAT to return', () => {
    const out = matchMock([{ urlContains: '/api/save', delayMs: 300, status: 500 }], {
      url: 'https://app.test/api/save',
      method: 'POST',
    });
    expect(out.kind).toBe('fulfill');
    expect(out.status).toBe(500);
  });

  it('a body alone still fulfills — saying WHAT is what makes it a substitution', () => {
    const out = matchMock([{ urlContains: '/api/save', body: '{"ok":true}' }], {
      url: 'https://app.test/api/save',
      method: 'POST',
    });
    expect(out.kind).toBe('fulfill');
  });

  it('abort still wins over everything — a failure is not a delay', () => {
    const out = matchMock([{ urlContains: '/api/save', delayMs: 300, abort: true }], {
      url: 'https://app.test/api/save',
      method: 'POST',
    });
    expect(out.kind).toBe('abort');
  });
});
