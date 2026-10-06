import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ComponentStateReason,
  ReticleCommand,
  type ComponentStateResult,
  type MatchResult,
} from '@reticlehq/core';
import { createCommandRegistry, resolveNavigationUrl } from './commands.js';
import { refs } from '@/dom/addressing/refs.js';
import { registerStore, unregisterStore } from '@/registry/stores.js';
import { registerAdapter, type ReticleAdapter } from '@/registry/stores/adapters.js';
import { registerCapabilities } from '@/registry/capabilities.js';

interface StateResult {
  stores: Record<string, unknown>;
  storeNames: string[];
  component?: unknown;
}

const reg = createCommandRegistry();

const adapters = ((
  globalThis as unknown as { __reticleAdapters?: ReticleAdapter[] }
).__reticleAdapters ??= []);

// Drop only the probe this file adds: other cases register their adapters once at load time (the
// `scoped_state` reader below), and clearing the whole registry would strand them.
afterEach(() => {
  const kept = adapters.filter((a) => 'plain-link-probe' !== a.name);
  adapters.length = 0;
  adapters.push(...kept);
});

function run(name: string, args: Record<string, unknown> = {}): unknown {
  const handler = reg.get(name);
  if (handler === undefined) throw new Error(`no handler ${name}`);
  return handler(args);
}

describe('command registry (driven by the bridge)', () => {
  it('allows relative/http(s) navigation and rejects executable protocols', () => {
    expect(resolveNavigationUrl('/next', 'https://app.example/current')).toBe(
      'https://app.example/next',
    );
    expect(resolveNavigationUrl('https://safe.example/path', 'https://app.example/')).toBe(
      'https://safe.example/path',
    );
    expect(resolveNavigationUrl('javascript:globalThis.pwned=true', 'https://app.example/')).toBe(
      null,
    );
    expect(resolveNavigationUrl('data:text/html,boom', 'https://app.example/')).toBe(null);
  });

  it('SNAPSHOT returns a tree with status', () => {
    document.body.innerHTML = '<button>Save</button>';
    const result = run(ReticleCommand.SNAPSHOT, {}) as { tree: string; status: { route: string } };
    expect(result.tree).toContain('button "Save"');
    expect(result.status.route).toBeDefined();
  });

  it('MATCH finds an element and reports state', () => {
    document.body.innerHTML = '<button disabled>Go</button>';
    const result = run(ReticleCommand.MATCH, {
      query: { role: 'button', name: 'Go' },
      state: 'disabled',
    }) as MatchResult;
    expect(result.matched).toBe(true);
  });

  it('ACT clicks the element referenced by a prior snapshot', () => {
    document.body.innerHTML = '<button>Click</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    const ref = refs.refFor(button);
    run(ReticleCommand.ACT, { ref, action: 'click' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('INSPECT returns descriptor + box for a ref', () => {
    document.body.innerHTML = '<a href="/x">Home</a>';
    const link = document.querySelector('a') as HTMLAnchorElement;
    const ref = refs.refFor(link);
    const result = run(ReticleCommand.INSPECT, { ref }) as { role: string; tag: string };
    expect(result.role).toBe('link');
    expect(result.tag).toBe('a');
  });

  /**
   * The descriptor is what the SERVER-side destructive guard sees, and it has no element there.
   *
   * So the facts that make an anchor not a plain navigation have to travel on the descriptor, or
   * the native path exempts a link the page wired up in the markup. `hasClickHandler` is present
   * only when a reading was actually taken, and a reading here can only ever be `true`: a page can
   * prove a handler PRESENT, never that one is ABSENT, so a handlerless fact is never on the
   * descriptor. That reading comes from CDP.
   */
  it('INSPECT reports the plain-navigation facts it could read', () => {
    registerAdapter({
      name: 'plain-link-probe',
      identify: () => null,
      hasClickHandler: (el) => el instanceof HTMLAnchorElement && '#wired' === el.id,
    });
    document.body.innerHTML =
      '<a id="plain" href="/billing/payment">Orders</a>' +
      '<a id="wired" href="/purchase/confirm" onclick="void 0">Purchase</a>' +
      '<div id="fake" role="link">Delete account</div>' +
      '<form action="/api/refund"><a id="inform" href="/help">Help</a></form>';
    const read = (selector: string): Record<string, unknown> => {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLElement)) throw new Error(`no element for ${selector}`);
      return run(ReticleCommand.INSPECT, { ref: refs.refFor(el) }) as Record<string, unknown>;
    };
    // The probe answered `false` for `#plain`, and the descriptor still carries no handler fact:
    // a framework's props are not where every listener lives, so this reading cannot be trusted as
    // an absence.
    expect(read('#plain')).toMatchObject({ isAnchor: true, insideForm: false });
    expect('hasClickHandler' in read('#plain')).toBe(false);
    expect(read('#wired')).toMatchObject({ isAnchor: true, hasClickHandler: true });
    expect(read('#fake')).toMatchObject({ isAnchor: false });
    expect(read('#inform')).toMatchObject({ isAnchor: true, insideForm: true });
  });

  /**
   * The unreadable case, pinned: no adapter can inspect anything, so the descriptor must NOT claim
   * a handler reading it never took. An anchor wired up with `addEventListener` is exactly this
   * shape, and the guard refuses the absent fact.
   */
  it('INSPECT omits the handler fact when nothing could read the element', () => {
    document.body.innerHTML = '<a id="orders" href="/billing/payment">Orders</a>';
    const el = document.querySelector('#orders');
    if (!(el instanceof HTMLElement)) throw new Error('fixture element missing');
    const read = run(ReticleCommand.INSPECT, { ref: refs.refFor(el) }) as Record<string, unknown>;
    expect(read).toMatchObject({ isAnchor: true });
    expect('hasClickHandler' in read).toBe(false);
  });

  /**
   * A non-GET marker must survive INSPECT, or the server-side guard is blind to it.
   *
   * `assertNotDestructive` classifies the DESCRIPTOR with no element in reach, so a marker the
   * descriptor does not carry is a marker that guard cannot act on. `data-turbo-method="delete"` on
   * an otherwise plain `<a href>` is the exact shape: the href reads as a GET and no handler is
   * visible, so without the field on the descriptor the link is exempted and the click destroys.
   *
   * The end-to-end half (descriptor -> `assertNotDestructive`) lives in
   * `server/src/surface/tools/act/act-danger.test.ts`; the browser package cannot import the server.
   */
  it('INSPECT carries the non-GET marker on the descriptor', () => {
    document.body.innerHTML =
      '<a id="turbo" href="/account" data-turbo-method="delete">Delete account</a>';
    const el = document.querySelector('#turbo');
    if (!(el instanceof HTMLElement)) throw new Error('fixture element missing');
    const read = run(ReticleCommand.INSPECT, { ref: refs.refFor(el) }) as Record<string, unknown>;
    expect(read).toMatchObject({ isAnchor: true, nonGetMarker: true });
  });

  it('INSPECT omits the non-GET marker for a link that has none', () => {
    document.body.innerHTML = '<a id="plain" href="/billing/payment">Orders</a>';
    const el = document.querySelector('#plain');
    if (!(el instanceof HTMLElement)) throw new Error('fixture element missing');
    const read = run(ReticleCommand.INSPECT, { ref: refs.refFor(el) }) as Record<string, unknown>;
    expect('nonGetMarker' in read).toBe(false);
  });

  it('INSPECT returns scroll metrics for a ref', () => {
    document.body.innerHTML = '<div style="overflow-y: auto; height: 100px;">content</div>';
    const div = document.querySelector('div') as HTMLDivElement;
    Object.defineProperty(div, 'scrollTop', { value: 50, configurable: true });
    Object.defineProperty(div, 'scrollHeight', { value: 300, configurable: true });
    Object.defineProperty(div, 'clientHeight', { value: 100, configurable: true });
    const ref = refs.refFor(div);
    const result = run(ReticleCommand.INSPECT, { ref }) as {
      scroll: { scrollTop: number; scrollHeight: number; clientHeight: number; overflowY: string };
    };
    expect(result.scroll.scrollTop).toBe(50);
    expect(result.scroll.scrollHeight).toBe(300);
    expect(result.scroll.clientHeight).toBe(100);
    expect(result.scroll.overflowY).toBe('auto');
  });

  it('STATE_READ returns a registered store and its name', () => {
    registerStore('state_ws', () => ({ count: 7 }));
    const result = run(ReticleCommand.STATE_READ, { store: 'state_ws' }) as StateResult;
    expect(result.stores['state_ws']).toEqual({ count: 7 });
    expect(result.storeNames).toContain('state_ws');
    unregisterStore('state_ws');
  });

  it('STATE_READ with no ref omits the component key', () => {
    const result = run(ReticleCommand.STATE_READ, {}) as StateResult;
    expect(result.component).toBeUndefined();
  });

  it('STATE_READ scopes a dot-path IN-PAGE before the transport (no whole-store payload)', () => {
    registerStore('state_app', () => ({
      deployments: [{ id: 1, status: 'queued' }],
      requestLog: [{ path: '/api/x', status: 200 }],
    }));
    const r = run(ReticleCommand.STATE_READ, {
      store: 'state_app',
      path: 'deployments.0.status',
    }) as Record<string, unknown>;
    expect(r['found']).toBe(true);
    expect(r['value']).toBe('queued');
    expect(r['stores']).toBeUndefined(); // the whole store never crosses the wire
    unregisterStore('state_app');
  });

  it('STATE_READ resolves a row PAST the transport array cap (select before sanitize)', () => {
    // 300 rows > MAX_COLLECTION_ITEMS (200): the old sanitize-then-select path truncated the array
    // to 200 and lost row 250. Selecting the raw store first must still find it.
    registerStore('state_app', () => ({
      deployments: Array.from({ length: 300 }, (_, i) => ({ id: i, status: `s${String(i)}` })),
    }));
    const r = run(ReticleCommand.STATE_READ, {
      store: 'state_app',
      path: 'deployments.250.status',
    }) as Record<string, unknown>;
    expect(r['found']).toBe(true);
    expect(r['value']).toBe('s250');
    unregisterStore('state_app');
  });

  it('STATE_READ depth caps a large sub-tree to a size marker in-page', () => {
    registerStore('state_app', () => ({ deployments: [1, 2, 3, 4, 5] }));
    const r = run(ReticleCommand.STATE_READ, {
      store: 'state_app',
      path: 'deployments',
      depth: 0,
    }) as Record<string, unknown>;
    expect(r['value']).toBe('[Array(5)]');
    unregisterStore('state_app');
  });

  it('STATE_READ a missing path returns found:false + the keys that WERE available', () => {
    registerStore('state_app', () => ({ deployments: [{ status: 'live' }] }));
    const r = run(ReticleCommand.STATE_READ, {
      store: 'state_app',
      path: 'deployments.0.nope',
    }) as Record<string, unknown>;
    expect(r['found']).toBe(false);
    expect(r['availableKeys']).toContain('status');
    unregisterStore('state_app');
  });

  it('STATE_READ with a bogus ref returns a bounded structured failure (no reject)', () => {
    let result: StateResult | undefined;
    expect(() => {
      result = run(ReticleCommand.STATE_READ, { ref: 'e999999' }) as StateResult;
    }).not.toThrow();
    expect(result?.component).toEqual({
      ok: false,
      reason: ComponentStateReason.UNAVAILABLE,
    });
  });

  // The adapter registry is a global array with no unregister; an element-scoped readState
  // (returns undefined unless the element opts in via data-state) keeps these tests isolated.
  const STATE_ATTR = 'data-state-kind';
  registerAdapter({
    name: 'scoped_state',
    identify: () => null,
    readState: (el) => {
      const kind = el.getAttribute(STATE_ATTR);
      if ('ok' === kind) return { ok: true, hooks: [1] } satisfies ComponentStateResult;
      if ('raw' === kind) return { hooks: [1] }; // non-conforming (no `ok`)
      return undefined; // unowned element -> no value
    },
  });

  it('STATE_READ reads a conforming component state via an adapter readState', () => {
    document.body.innerHTML = `<button ${STATE_ATTR}="ok">Hi</button>`;
    const button = document.querySelector('button') as HTMLButtonElement;
    const ref = refs.refFor(button);
    const result = run(ReticleCommand.STATE_READ, { ref }) as StateResult;
    expect(result.component).toEqual({ ok: true, hooks: [1] });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('STATE_READ wraps a non-conforming adapter result as a structured failure ', () => {
    document.body.innerHTML = `<span ${STATE_ATTR}="raw">Raw</span>`;
    const el = document.querySelector('span') as HTMLElement;
    const ref = refs.refFor(el);
    const result = run(ReticleCommand.STATE_READ, { ref }) as StateResult;
    expect(result.component).toEqual({ ok: false, reason: ComponentStateReason.UNAVAILABLE });
  });

  it('STATE_READ with a real ref but no readState adapter returns a structured failure', () => {
    document.body.innerHTML = '<i>x</i>';
    const el = document.querySelector('i') as HTMLElement;
    const ref = refs.refFor(el);
    const result = run(ReticleCommand.STATE_READ, { ref }) as StateResult;
    expect(result.component).toEqual({ ok: false, reason: ComponentStateReason.UNAVAILABLE });
  });

  it('STATE_READ store path stays the reliable, never-wrapped contract', () => {
    registerStore('state_ws', () => ({ count: 7 }));
    const result = run(ReticleCommand.STATE_READ, { store: 'state_ws' }) as StateResult;
    expect(result.stores['state_ws']).toEqual({ count: 7 });
    expect(result.component).toBeUndefined();
    expect(() => JSON.stringify(result)).not.toThrow();
    unregisterStore('state_ws');
  });

  it('QUERY forwards the component field into the auto-anchor resolution path', () => {
    const MARKER = 'data-query-component-test';
    document.body.innerHTML = `<button ${MARKER}>Submit</button>`;
    registerAdapter({
      name: 'query_component_test',
      identify: (el) => (el.hasAttribute(MARKER) ? { componentStack: ['SubmitButton'] } : null),
      readState: () => undefined,
    });
    const result = run(ReticleCommand.QUERY, { component: 'SubmitButton' }) as {
      elements: unknown[];
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.elements).toHaveLength(1);
  });

  it('QUERY forwards the source field into the auto-anchor resolution path', () => {
    document.body.innerHTML = '<input data-reticle-source="form.tsx:42:5" placeholder="Email" />';
    const result = run(ReticleCommand.QUERY, {
      source: { file: 'form.tsx', line: 42 },
    }) as { elements: unknown[]; count: number };
    expect(result.count).toBe(1);
    expect(result.elements).toHaveLength(1);
  });

  it('QUERY with malformed source returns empty results (no crash)', () => {
    document.body.innerHTML = '<button>Click</button>';
    for (const bad of [null, 'string', 42, { file: 'x' }, { line: 1 }]) {
      const result = run(ReticleCommand.QUERY, { source: bad }) as {
        elements: unknown[];
        count: number;
      };
      expect(result.count).toBe(0);
    }
  });

  it('CAPABILITIES returns the registered capabilities', () => {
    registerCapabilities({
      testids: ['item-list'],
      flows: [{ name: 'checkout', steps: ['fill', 'submit'] }],
    });
    const result = run(ReticleCommand.CAPABILITIES) as {
      testids: string[];
      flows: { name: string; steps: string[] }[];
    };
    expect(result.testids).toContain('item-list');
    expect(result.flows.some((f) => 'checkout' === f.name)).toBe(true);
  });
});
