import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import {
  consoleEmptyHint,
  netEmptyHint,
  reconcileNet,
  projectNetCall,
  projectConsoleLog,
  isConsoleEvent,
  eventMatchesFilters,
  matchNet,
  OBSERVE_FILTER_BUCKETS,
} from './event-filters.js';

function ev(type: EventType, data: Record<string, unknown> = {}, t = 1): ReticleEvent {
  return { t, type, sessionId: 's', data };
}

describe('eventMatchesFilters (observe filters allowlist)', () => {
  it('keeps net.request when the documented bucket name "net" is passed', () => {
    // The whole point: the schema advertises bucket names, not raw types. Passing the documented
    // value must keep the matching events — before the fix this returned false and the agent got
    // an empty (false-green) timeline.
    expect(eventMatchesFilters(ev(EventType.NET_REQUEST), ['net'])).toBe(true);
    expect(eventMatchesFilters(ev(EventType.DOM_ADDED), ['dom'])).toBe(true);
    expect(eventMatchesFilters(ev(EventType.CONSOLE_ERROR), ['console'])).toBe(true);
    expect(eventMatchesFilters(ev(EventType.SIGNAL), ['signal'])).toBe(true);
  });

  it('excludes events outside the requested bucket', () => {
    expect(eventMatchesFilters(ev(EventType.DOM_ADDED), ['net'])).toBe(false);
    expect(eventMatchesFilters(ev(EventType.NET_REQUEST), ['console'])).toBe(false);
  });

  it('also accepts a raw event type, so both spellings work', () => {
    expect(eventMatchesFilters(ev(EventType.NET_REQUEST), ['net.request'])).toBe(true);
    expect(eventMatchesFilters(ev(EventType.DOM_TEXT), ['dom.text'])).toBe(true);
  });

  it('an unknown filter entry narrows rather than throws', () => {
    expect(eventMatchesFilters(ev(EventType.NET_REQUEST), ['nonsense'])).toBe(false);
  });

  it('an Object.prototype key as a filter does not crash the matcher', () => {
    // The map is a plain object, so `map['toString']` is the inherited function, not undefined —
    // a bare index would then call `.includes` on a function and throw. These must fall through to
    // the raw-type comparison and simply not match.
    for (const proto of ['toString', 'hasOwnProperty', 'constructor', '__proto__']) {
      expect(eventMatchesFilters(ev(EventType.NET_REQUEST), [proto])).toBe(false);
    }
  });

  it('"console" bucket covers uncaught errors, not just console.error', () => {
    expect(eventMatchesFilters(ev(EventType.ERROR_UNCAUGHT), ['console'])).toBe(true);
  });

  it('perf / state / storage resolve as buckets too', () => {
    expect(eventMatchesFilters(ev(EventType.PERF), ['perf'])).toBe(true);
    expect(eventMatchesFilters(ev(EventType.STATE_CHANGE), ['state'])).toBe(true);
    expect(eventMatchesFilters(ev(EventType.STORAGE_CHANGE), ['storage'])).toBe(true);
  });

  it('every advertised bucket name resolves to at least one real event type', () => {
    // The bug this guards: the schema advertised names that equalled no event type, so filtering
    // returned nothing. Any future bucket added to the description must map to something real.
    for (const [bucket, types] of Object.entries(OBSERVE_FILTER_BUCKETS)) {
      expect(types.length, `bucket "${bucket}" maps to no event types`).toBeGreaterThan(0);
      for (const t of types) {
        expect(eventMatchesFilters(ev(t as EventType), [bucket])).toBe(true);
      }
    }
  });
});

describe('matchNet ok filter (the documented way to find a failed desktop IPC call)', () => {
  const ok = ev(EventType.NET_REQUEST, {
    method: 'ipc',
    url: 'ipc://todos:load',
    status: 200,
    ok: true,
  });
  const failed = ev(EventType.NET_REQUEST, {
    method: 'ipc',
    url: 'ipc://todos:archive',
    status: 500,
    ok: false,
  });

  it('keeps only the failed call when ok:false is asked for', () => {
    // reticle_network's own description tells the agent to filter IPC on `ok`, because the 200/500
    // there is derived. Without this the filter was ignored and a "show me what failed" query came
    // back listing calls that SUCCEEDED — a false green on the exact desktop path it documents.
    expect(matchNet(failed, undefined, undefined, undefined, false)).toBe(true);
    expect(matchNet(ok, undefined, undefined, undefined, false)).toBe(false);
  });

  it('keeps only the successful call when ok:true is asked for', () => {
    expect(matchNet(ok, undefined, undefined, undefined, true)).toBe(true);
    expect(matchNet(failed, undefined, undefined, undefined, true)).toBe(false);
  });

  it('leaves every call in place when ok is omitted', () => {
    expect(matchNet(ok, undefined, undefined, undefined, undefined)).toBe(true);
    expect(matchNet(failed, undefined, undefined, undefined, undefined)).toBe(true);
  });

  it('excludes a still-pending call from ok:false — unresolved is not failed', () => {
    const pending = ev(EventType.NET_PENDING, { method: 'ipc', url: 'ipc://todos:add' });
    expect(matchNet(pending, undefined, undefined, undefined, false)).toBe(false);
  });
});

describe('reconcileNet (in-flight / hung requests)', () => {
  it('keeps a completed request and drops its matching pending (no double-count)', () => {
    const events = [
      ev(EventType.NET_PENDING, { id: 'n1', method: 'GET', url: '/api/x' }, 1),
      ev(EventType.NET_REQUEST, { id: 'n1', method: 'GET', url: '/api/x', status: 200 }, 2),
    ];
    const out = reconcileNet(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe(EventType.NET_REQUEST);
    expect(out[0]?.data['status']).toBe(200);
  });

  it('surfaces a pending with no completion as an in-flight call annotated pending', () => {
    const events = [
      ev(EventType.NET_REQUEST, { id: 'n1', method: 'POST', url: '/api/login', status: 200 }, 1),
      ev(EventType.NET_PENDING, { id: 'n2', method: 'GET', url: '/api/broken/timeout' }, 2),
    ];
    const out = reconcileNet(events);
    expect(out).toHaveLength(2);
    const hung = out.find((e) => '/api/broken/timeout' === e.data['url']);
    expect(hung?.data).toMatchObject({ status: 'pending', pending: true });
  });

  it('orders the reconciled calls by time', () => {
    const events = [
      ev(EventType.NET_PENDING, { id: 'n2', url: '/late' }, 5),
      ev(EventType.NET_REQUEST, { id: 'n1', url: '/early', status: 200 }, 1),
    ];
    const out = reconcileNet(events);
    expect(out.map((e) => e.data['url'])).toEqual(['/early', '/late']);
  });
});

describe('compact projections (token leanness)', () => {
  it('projectNetCall keeps only method/url/status/ms and drops event plumbing', () => {
    const e = ev(EventType.NET_REQUEST, {
      id: 'n1',
      method: 'POST',
      url: '/api/x',
      status: 500,
      ok: false,
      durationMs: 42,
      initiator: 'fetch',
    });
    expect(projectNetCall(e)).toEqual({ method: 'POST', url: '/api/x', status: 500, ms: 42 });
  });

  it('projectNetCall includes bodies by default and drops them when includeBodies is false (#401)', () => {
    const e = ev(EventType.NET_REQUEST, {
      method: 'POST',
      url: '/api/todos',
      status: 201,
      durationMs: 12,
      requestBody: '{"title":"buy milk"}',
      responseBody: '{"id":7}',
      responseBodyTruncated: true,
    });
    // Default: bodies are present (unchanged behaviour).
    const full = projectNetCall(e);
    expect(full.requestBody).toBe('{"title":"buy milk"}');
    expect(full.responseBody).toBe('{"id":7}');
    expect(full.bodyTruncated).toBe(true);
    // Body-free listing: method/url/status/timing survive, the bodies are gone.
    expect(projectNetCall(e, false)).toEqual({
      method: 'POST',
      url: '/api/todos',
      status: 201,
      ms: 12,
    });
  });

  it('projectNetCall passes through a pending (no-status) request', () => {
    const e = ev(EventType.NET_PENDING, {
      method: 'GET',
      url: '/api/hang',
      status: 'pending',
      pending: true,
    });
    expect(projectNetCall(e)).toEqual({ method: 'GET', url: '/api/hang', status: 'pending' });
  });

  it('projectConsoleLog maps type to level and extracts the message', () => {
    expect(projectConsoleLog(ev(EventType.CONSOLE_ERROR, { message: 'boom' }))).toEqual({
      level: 'error',
      text: 'boom',
    });
    expect(projectConsoleLog(ev(EventType.ERROR_UNCAUGHT, { message: 'uncaught x' }))).toEqual({
      level: 'error',
      text: 'uncaught x',
    });
    expect(projectConsoleLog(ev(EventType.CONSOLE_INFO, { message: 'fyi' }))).toEqual({
      level: 'info',
      text: 'fyi',
    });
    expect(projectConsoleLog(ev(EventType.CONSOLE_DEBUG, { message: 'dbg' }))).toEqual({
      level: 'debug',
      text: 'dbg',
    });
  });

  it('reconcileNet folds CDP-authoritative headers onto the matching request (driven fidelity)', () => {
    const merged = reconcileNet([
      ev(EventType.NET_REQUEST, { id: '1', method: 'GET', url: '/api/x', status: 200 }),
      ev(
        EventType.NET_DETAIL,
        { url: '/api/x', method: 'GET', status: 200, headers: { etag: 'v9' } },
        2,
      ),
    ]);
    const call = projectNetCall(merged[0] as ReticleEvent);
    expect(call.headers).toEqual({ etag: 'v9' });
  });

  it('isConsoleEvent includes info/debug so reticle_console can surface them', () => {
    expect(isConsoleEvent(ev(EventType.CONSOLE_INFO, { message: 'i' }))).toBe(true);
    expect(isConsoleEvent(ev(EventType.CONSOLE_DEBUG, { message: 'd' }))).toBe(true);
    expect(isConsoleEvent(ev(EventType.NET_REQUEST, {}))).toBe(false);
  });
});

describe('near-miss hint builders', () => {
  it('netEmptyHint: reports total + a most-recent-first sample of present calls', () => {
    const allNet = [
      ev(EventType.NET_REQUEST, { method: 'GET', url: '/a', status: 200 }),
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/b', status: 500 }),
    ];
    const hint = netEmptyHint(allNet);
    expect(hint.totalInWindow).toBe(2);
    expect(hint.present[0]).toEqual({ method: 'POST', url: '/b', status: 500 });
    expect(hint.present[1]).toEqual({ method: 'GET', url: '/a', status: 200 });
  });

  it('netEmptyHint: caps the sample at 5 (keeps the most recent)', () => {
    const allNet = Array.from({ length: 8 }, (_, i) =>
      ev(EventType.NET_REQUEST, { method: 'GET', url: `/u${i}`, status: 200 }),
    );
    const hint = netEmptyHint(allNet);
    expect(hint.totalInWindow).toBe(8);
    expect(hint.present).toHaveLength(5);
    expect(hint.present[0]?.url).toBe('/u7'); // most recent first
  });

  it('netEmptyHint: omits status when the call has none (no undefined leak)', () => {
    const hint = netEmptyHint([ev(EventType.NET_REQUEST, { method: 'GET', url: '/pending' })]);
    expect(hint.present[0]).toEqual({ method: 'GET', url: '/pending' });
    expect('status' in (hint.present[0] ?? {})).toBe(false);
  });

  it('consoleEmptyHint: counts events by level (uncaught counts as error)', () => {
    const all = [
      ev(EventType.CONSOLE_LOG, { message: 'a' }),
      ev(EventType.CONSOLE_LOG, { message: 'b' }),
      ev(EventType.CONSOLE_WARN, { message: 'w' }),
      ev(EventType.CONSOLE_ERROR, { message: 'e' }),
      ev(EventType.ERROR_UNCAUGHT, { message: 'boom' }),
    ];
    const hint = consoleEmptyHint(all);
    expect(hint.totalInWindow).toBe(5);
    expect(hint.byLevel).toEqual({ log: 2, warn: 1, error: 2 });
  });
});

/**
 * An error's stack is the only localization signal a console failure has. The browser already goes
 * out of its way to capture it for console.error only (log/warn stay lean), and the projection then
 * threw it away — so the agent was told "something threw" and had to go find where on its own.
 *
 * Trimmed to the frames that identify the origin: a full stack is mostly framework internals, and
 * padding a failure report with them measurably hurts more than it helps.
 */
describe('console projections keep the origin of an error', () => {
  const stack = [
    'Error: total is NaN',
    '    at computeTotal (/src/lib/cart.ts:42:11)',
    '    at Cart (/src/views/Cart.tsx:88:20)',
    '    at renderWithHooks (/node_modules/react-dom/cjs/react-dom.development.js:14985:18)',
    '    at mountIndeterminateComponent (/node_modules/react-dom/cjs/react-dom.development.js:17811:13)',
  ].join('\n');

  it('carries the stack for an error that has one', () => {
    const view = projectConsoleLog(ev(EventType.CONSOLE_ERROR, { message: 'boom', stack }));
    expect(view.stack).toContain('computeTotal (/src/lib/cart.ts:42:11)');
  });

  it('trims to the top frames rather than shipping the whole framework trace', () => {
    const view = projectConsoleLog(ev(EventType.CONSOLE_ERROR, { message: 'boom', stack }));
    expect(view.stack).not.toContain('mountIndeterminateComponent');
  });

  it('omits stack entirely when the event has none, rather than emitting an empty field', () => {
    const view = projectConsoleLog(ev(EventType.CONSOLE_INFO, { message: 'fyi' }));
    expect('stack' in view).toBe(false);
  });

  it('carries the file and line of an uncaught error', () => {
    const view = projectConsoleLog(
      ev(EventType.ERROR_UNCAUGHT, {
        message: 'x is not a function',
        source: '/src/App.tsx',
        line: 17,
      }),
    );
    expect(view.source).toBe('/src/App.tsx:17');
  });
});
