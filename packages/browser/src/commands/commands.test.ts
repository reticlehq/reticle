import { describe, it, expect, vi } from 'vitest';
import {
  ComponentStateReason,
  ReticleCommand,
  type ComponentStateResult,
  type MatchResult,
} from '@reticlehq/core';
import { createCommandRegistry, resolveNavigationUrl } from './commands.js';
import { refs } from '../dom/refs.js';
import { registerStore, unregisterStore } from '../registry/stores.js';
import { registerAdapter } from '../registry/adapters.js';
import { registerCapabilities } from '../registry/capabilities.js';

interface StateResult {
  stores: Record<string, unknown>;
  storeNames: string[];
  component?: unknown;
}

const reg = createCommandRegistry();

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
      if (kind === 'ok') return { ok: true, hooks: [1] } satisfies ComponentStateResult;
      if (kind === 'raw') return { hooks: [1] }; // non-conforming (no `ok`)
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
    expect(result.flows.some((f) => f.name === 'checkout')).toBe(true);
  });
});
