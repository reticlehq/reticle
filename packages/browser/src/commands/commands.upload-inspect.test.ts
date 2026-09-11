import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCommandRegistry } from './commands.js';
import { executeAction } from '../actions/actions.js';
import { refs } from '../dom/refs.js';
import { registerAdapter } from '../registry/adapters.js';

const reg = createCommandRegistry();

describe('upload action', () => {
  it('rejects a non-file target with a clear error', async () => {
    document.body.innerHTML = '<input type="text" />';
    const el = document.querySelector('input') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'upload', { name: 'x.txt' })).rejects.toThrow(
      /file/,
    );
  });
});

describe('inspect computed styles (for hover/visual checks)', () => {
  it('returns color + backgroundColor for a ref', () => {
    document.body.innerHTML = '<button style="background: rgb(1, 2, 3)">Hi</button>';
    const el = document.querySelector('button') as HTMLButtonElement;
    const handler = reg.get('inspect');
    if (handler === undefined) throw new Error('no inspect handler');
    const info = handler({ ref: refs.refFor(el) }) as {
      styles: { backgroundColor: string } | null;
    };
    expect(info.styles).not.toBeNull();
    expect(info.styles?.backgroundColor).toContain('rgb');
  });
});

/**
 * A stale ref is the most ordinary thing that follows a click, and `inspect` answered it with a
 * PROTOCOL error.
 *
 * `inspect` RETURNED `{ error }` as a successful command result, so the server passed it straight
 * into reticle_inspect's outputSchema — which requires ref/role/name/states/visible — and the MCP
 * layer rejected the tool's own response. Measured over real MCP: `reticle_act` on ref 'e99999'
 * answers "that ref is stale, re-query and retry", while `reticle_inspect` on the SAME ref answers
 * `-32602 Output validation error: … "path": ["ref"], "message": "Required"`. Same condition, one
 * hop apart, and the tool an agent reaches for to ask where something lives is the one that breaks.
 *
 * It has to THROW, like `executeAction` does, and with the same wording: the server's recovery table
 * matches /no longer resolves to an element/, so the shorter message this used to carry would have
 * missed the stale-ref recovery even once it was surfaced as an error.
 */
describe('inspect on a stale ref', () => {
  it('throws the same stale-ref error act does, instead of returning an error payload', () => {
    const handler = reg.get('inspect');
    if (handler === undefined) throw new Error('no inspect handler');
    expect(() => handler({ ref: 'e99999' })).toThrow(/no longer resolves to an element/);
  });
});

/**
 * `inspect` and `act` disagreed about the same element.
 *
 * `describe()` reads the cheap DOM-attribute source, because it runs per element on paths that
 * describe hundreds at once. Single-element paths are supposed to use `sourceFor()`, which asks the
 * framework adapter FIRST — it knows the component that RENDERED the element, not just the nearest
 * stamped host. `act` did; `inspect` did not. So on any app whose source comes from the fiber rather
 * than a babel stamp, `inspect` reported `source: null` while `act` on the very same ref returned a
 * path — and `inspect` is the tool an agent reaches for to ask where something lives. Observed on
 * three of six real apps.
 */
describe('inspect source agrees with the adapter, not just the DOM stamp', () => {
  /** A stand-in for @reticlehq/react: answers for elements carrying a marker attribute. */
  const fakeAdapter = {
    name: 'test-adapter',
    identify: (el: Element) =>
      el.hasAttribute('data-fake-component')
        ? { componentStack: ['PayButton'], source: { file: 'src/Pay.tsx', line: 12, column: 3 } }
        : null,
  };
  beforeAll(() => registerAdapter(fakeAdapter));
  afterAll(() => {
    const store = globalThis as unknown as { __reticleAdapters?: { name: string }[] };
    const list = store.__reticleAdapters ?? [];
    const i = list.findIndex((a) => a.name === fakeAdapter.name);
    if (i >= 0) list.splice(i, 1);
  });

  it('reports the ADAPTER source when there is no data-reticle-source attribute', () => {
    document.body.innerHTML = '<button data-fake-component>Pay</button>';
    const el = document.querySelector('button') as HTMLButtonElement;
    const handler = reg.get('inspect');
    if (handler === undefined) throw new Error('no inspect handler');
    const info = handler({ ref: refs.refFor(el) }) as { source?: string; component?: unknown };
    // The adapter must actually have answered, or this test proves nothing.
    expect(info.component, 'the fake adapter did not identify the element').not.toBeNull();
    expect(info.source).toBe('src/Pay.tsx:12');
  });

  it('still falls back to the DOM stamp when no adapter can answer', () => {
    document.body.innerHTML = '<div data-reticle-source="src/A.tsx:5:2"><span>x</span></div>';
    const el = document.querySelector('span') as HTMLElement;
    const handler = reg.get('inspect');
    if (handler === undefined) throw new Error('no inspect handler');
    const info = handler({ ref: refs.refFor(el) }) as { source?: string };
    expect(info.source).toBe('src/A.tsx:5');
  });
});
