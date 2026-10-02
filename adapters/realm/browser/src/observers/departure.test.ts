/**
 * Where the browser is about to GO, recorded before it goes.
 *
 * Two journeys were unprovable for the same reason: the SDK dies with the document, so the one fact
 * worth asserting was gone before anything could read it.
 *
 * - An OAuth handoff. `act_and_wait` on a "Sign in with <provider>" link returned
 *   `observation_lost` the moment the tab left the instrumented origin. The checkable claim is
 *   narrow — does the app hand the browser to the expected provider, with the expected parameters?
 *   — and it came back `unknown`.
 * - A native download. `<a download href="/api/export.pdf">` produces no fetch and no new document,
 *   so a 20-second window recorded zero network activity while `curl` showed that URL answering 200.
 *
 * The honesty rule this pins: a departure is emitted as an UNMATCHED PENDING, never as a completed
 * request. We observe an intention, not an outcome. A synthesised 200 here would make every outbound
 * link a false green.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventType, NetInitiator } from '@reticlehq/core';
import { installDeparture, isDeparture } from './departure.js';

const HERE = 'http://localhost:5173/dashboard';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

let events: Captured[];
let teardown: () => void;

beforeEach(() => {
  window.history.replaceState({}, '', '/dashboard');
  document.body.innerHTML = '';
  events = [];
  teardown = installDeparture((type, data) => events.push({ type, data }));
});
afterEach(() => {
  teardown();
  document.body.innerHTML = '';
});

/**
 * Dispatch a click and let the whole dispatch finish.
 *
 * The record is written after the event has been through every handler, so reading `events` in the
 * same synchronous turn as the dispatch would read them before they exist. One microtask is the
 * whole wait — see the note on `defaultPrevented` in departure.ts.
 */
async function settle(): Promise<Captured[]> {
  await Promise.resolve();
  return events;
}

/** Click an anchor with the given attributes and return whatever was emitted. */
async function clickAnchor(attrs: Record<string, string>): Promise<Captured[]> {
  const a = document.createElement('a');
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = 'go';
  document.body.appendChild(a);
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return settle();
}

describe('leaving for another origin is recorded', () => {
  it('names the provider the app handed the browser to', async () => {
    const [event] = await clickAnchor({
      href: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&scope=email',
    });
    expect(event?.type).toBe(EventType.NET_PENDING);
    expect(event?.data['url']).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(event?.data['url'], 'the parameters are the checkable half of the claim').toContain(
      'client_id=abc',
    );
    expect(event?.data['initiator']).toBe(NetInitiator.NAVIGATION);
  });

  it('records an intention, never an outcome', async () => {
    const [event] = await clickAnchor({ href: 'https://accounts.google.com/o/oauth2/v2/auth' });
    expect(event?.data['status'], 'a synthesised status would make every link a false green').toBe(
      undefined,
    );
    expect(event?.data['ok']).toBeUndefined();
  });

  it('finds the anchor through the markup a real link wraps', async () => {
    document.body.innerHTML =
      '<a href="https://accounts.google.com/o"><span id="in">Sign in</span></a>';
    document
      .querySelector('#in')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(await settle()).toHaveLength(1);
  });

  it('records a click no handler cancelled, however late the handler runs', async () => {
    document.body.innerHTML = '<a href="https://accounts.google.com/o">Sign in</a>';
    const a = document.querySelector('a');
    a?.addEventListener('click', () => undefined);
    a?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(
      await settle(),
      'the browser is still going: an uncancelled anchor click is a departure',
    ).toHaveLength(1);
  });
});

describe('a client-side router keeps its own link', () => {
  /**
   * A tab that switches with `?tab=wrap` is a route change, not a request. The router cancels the
   * anchor's default and swaps the view in this same document, so nothing was ever dispatched to the
   * network — but a record written at click time said one was, and a pending that cannot settle
   * because it never started is graded as a request still in flight. Every flow step that clicked a
   * tab then carried a request-never-settled contradiction and the suite reported `unverifiable`
   * while every declared consequence had held.
   */
  it('says nothing when the app cancels the anchor and routes in-document', async () => {
    document.body.innerHTML = '<a href="/dashboard?tab=wrap">Wrap</a>';
    const a = document.querySelector('a');
    a?.addEventListener('click', (e) => e.preventDefault());
    a?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(
      await settle(),
      'the browser never left, so there is no request whose outcome is unknown',
    ).toHaveLength(0);
  });

  it('says nothing when a handler upstream of the anchor cancels it', async () => {
    document.body.innerHTML = '<div id="root"><a href="/settings">Settings</a></div>';
    document.querySelector('#root')?.addEventListener('click', (e) => e.preventDefault());
    document
      .querySelector('a')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(
      await settle(),
      'a router delegating from a root container is the common case, not an exception',
    ).toHaveLength(0);
  });
});

describe('a native download is a departure too', () => {
  it('records a same-origin download, which produces no fetch and no new document', async () => {
    const [event] = await clickAnchor({ href: '/api/sessions/1/export.pdf', download: '' });
    expect(event?.data['url']).toBe(
      new URL('/api/sessions/1/export.pdf', location.href).toString(),
    );
    expect(event?.data['download']).toBe(true);
  });
});

describe('what is NOT a departure', () => {
  it.each([
    ['an in-page fragment', '#section-2'],
    ['a javascript: link', 'javascript:void(0)'],
    ['a mailto: link', 'mailto:a@b.co'],
    ['an empty href', ''],
  ])('says nothing for %s', async (_label, href) => {
    expect(await clickAnchor({ href })).toHaveLength(0);
  });

  it('says nothing for a click that is not on an anchor at all', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(await settle()).toHaveLength(0);
  });

  it('stops recording after teardown', async () => {
    teardown();
    expect(await clickAnchor({ href: 'https://accounts.google.com/o' })).toHaveLength(0);
  });
});

describe('the departure rule itself', () => {
  it.each([
    ['another origin', 'https://accounts.google.com/o', false, true],
    ['a different same-origin path', '/settings', false, true],
    ['the same path with a different query', '/dashboard?tab=2', false, true],
    ['the same path and query', '/dashboard', false, false],
    ['a bare fragment', '#top', false, false],
    ['a same-origin download', '/export.csv', true, true],
  ])('%s', (_label, href, download, expected) => {
    expect(isDeparture(href, download, HERE)).toBe(expected);
  });
});
