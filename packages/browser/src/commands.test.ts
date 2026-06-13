import { describe, it, expect, vi } from 'vitest';
import {
  ComponentStateReason,
  IrisCommand,
  type ComponentStateResult,
  type MatchResult,
} from '@iris/protocol';
import { createCommandRegistry } from './commands.js';
import { refs } from './refs.js';
import { registerStore, unregisterStore } from './stores.js';
import { registerAdapter } from './adapters.js';
import { registerCapabilities } from './capabilities.js';

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
  it('SNAPSHOT returns a tree with status', () => {
    document.body.innerHTML = '<button>Save</button>';
    const result = run(IrisCommand.SNAPSHOT, {}) as { tree: string; status: { route: string } };
    expect(result.tree).toContain('button "Save"');
    expect(result.status.route).toBeDefined();
  });

  it('MATCH finds an element and reports state', () => {
    document.body.innerHTML = '<button disabled>Go</button>';
    const result = run(IrisCommand.MATCH, {
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
    run(IrisCommand.ACT, { ref, action: 'click' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('INSPECT returns descriptor + box for a ref', () => {
    document.body.innerHTML = '<a href="/x">Home</a>';
    const link = document.querySelector('a') as HTMLAnchorElement;
    const ref = refs.refFor(link);
    const result = run(IrisCommand.INSPECT, { ref }) as { role: string; tag: string };
    expect(result.role).toBe('link');
    expect(result.tag).toBe('a');
  });

  it('STATE_READ returns a registered store and its name', () => {
    registerStore('state_ws', () => ({ count: 7 }));
    const result = run(IrisCommand.STATE_READ, { store: 'state_ws' }) as StateResult;
    expect(result.stores['state_ws']).toEqual({ count: 7 });
    expect(result.storeNames).toContain('state_ws');
    unregisterStore('state_ws');
  });

  it('STATE_READ with no ref omits the component key', () => {
    const result = run(IrisCommand.STATE_READ, {}) as StateResult;
    expect(result.component).toBeUndefined();
  });

  it('STATE_READ with a bogus ref returns a bounded structured failure (no reject) (F5)', () => {
    let result: StateResult | undefined;
    expect(() => {
      result = run(IrisCommand.STATE_READ, { ref: 'e999999' }) as StateResult;
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
    const result = run(IrisCommand.STATE_READ, { ref }) as StateResult;
    expect(result.component).toEqual({ ok: true, hooks: [1] });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('STATE_READ wraps a non-conforming adapter result as a structured failure (F5 guard)', () => {
    document.body.innerHTML = `<span ${STATE_ATTR}="raw">Raw</span>`;
    const el = document.querySelector('span') as HTMLElement;
    const ref = refs.refFor(el);
    const result = run(IrisCommand.STATE_READ, { ref }) as StateResult;
    expect(result.component).toEqual({ ok: false, reason: ComponentStateReason.UNAVAILABLE });
  });

  it('STATE_READ with a real ref but no readState adapter returns a structured failure (F5)', () => {
    document.body.innerHTML = '<i>x</i>';
    const el = document.querySelector('i') as HTMLElement;
    const ref = refs.refFor(el);
    const result = run(IrisCommand.STATE_READ, { ref }) as StateResult;
    expect(result.component).toEqual({ ok: false, reason: ComponentStateReason.UNAVAILABLE });
  });

  it('STATE_READ store path stays the reliable, never-wrapped contract', () => {
    registerStore('state_ws', () => ({ count: 7 }));
    const result = run(IrisCommand.STATE_READ, { store: 'state_ws' }) as StateResult;
    expect(result.stores['state_ws']).toEqual({ count: 7 });
    expect(result.component).toBeUndefined();
    expect(() => JSON.stringify(result)).not.toThrow();
    unregisterStore('state_ws');
  });

  it('CAPABILITIES returns the registered capabilities (G5)', () => {
    registerCapabilities({
      testids: ['item-list'],
      flows: [{ name: 'checkout', steps: ['fill', 'submit'] }],
    });
    const result = run(IrisCommand.CAPABILITIES) as {
      testids: string[];
      flows: { name: string; steps: string[] }[];
    };
    expect(result.testids).toContain('item-list');
    expect(result.flows.some((f) => f.name === 'checkout')).toBe(true);
  });
});
