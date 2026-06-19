import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementState, SnapshotMode } from '@syrin/iris-protocol';
import { getAccessibleName, getRole, getStates } from './a11y.js';
import { buildSnapshot } from './snapshot.js';
import { matchQuery, runQuery } from './query.js';
import { registerCapabilities } from '../registry/capabilities.js';
import { executeAction } from '../actions/actions.js';
import { refs } from './refs.js';

function render(html: string): void {
  document.body.innerHTML = html;
}

describe('a11y', () => {
  it('computes implicit roles', () => {
    render('<button>Go</button><a href="/x">Home</a><input type="checkbox" />');
    const [button, link, checkbox] = [
      document.querySelector('button'),
      document.querySelector('a'),
      document.querySelector('input'),
    ];
    expect(getRole(button as Element)).toBe('button');
    expect(getRole(link as Element)).toBe('link');
    expect(getRole(checkbox as Element)).toBe('checkbox');
  });

  it('derives accessible name from content, label, and aria-label', () => {
    render(`
      <button>Pay $42</button>
      <label>Email <input id="e" /></label>
      <button aria-label="Close dialog">×</button>
    `);
    expect(getAccessibleName(document.querySelector('button') as Element)).toBe('Pay $42');
    expect(getAccessibleName(document.getElementById('e') as Element)).toBe('Email');
    expect(getAccessibleName(document.querySelectorAll('button')[1] as Element)).toBe(
      'Close dialog',
    );
  });

  it('reports disabled and checked states', () => {
    render('<button disabled>X</button><input type="checkbox" checked />');
    expect(getStates(document.querySelector('button') as Element)).toContain(ElementState.DISABLED);
    expect(getStates(document.querySelector('input') as Element)).toContain(ElementState.CHECKED);
  });
});

describe('snapshot', () => {
  it('renders a semantic tree with refs for interactive elements', () => {
    render(`
      <main>
        <h1>Checkout</h1>
        <form aria-label="Payment">
          <input aria-label="Card number" />
          <button>Pay $42.00</button>
        </form>
      </main>
    `);
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.tree).toContain('heading "Checkout"');
    expect(snap.tree).toContain('button "Pay $42.00"');
    expect(snap.tree).toMatch(/textbox "Card number" \(ref=e\d+\)/);
    expect(snap.status.route).toBeDefined();
  });

  it('interactive mode lists only actionable elements', () => {
    render('<div><h1>Title</h1><button>Click</button></div>');
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).toContain('button "Click"');
    expect(snap.tree).not.toContain('heading');
  });

  it('includes text content of generic containers so silent content removal is visible', () => {
    // KPI-card shape: generic divs with no role/name carry the value text. Without this,
    // removing a card is invisible to the snapshot (the silent-DOM benchmark blind spot).
    render('<div class="kpi"><div>Deploys</div><div>1240</div></div>');
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.tree).toContain('Deploys');
    expect(snap.tree).toContain('1240');
  });

  it('a snapshot changes when a generic text node is removed (detects the regression)', () => {
    render('<section><div>Alpha</div><div>Beta</div></section>');
    const before = buildSnapshot({ mode: SnapshotMode.FULL }).tree;
    const section = document.querySelector('section');
    const last = section?.lastElementChild ?? null;
    if (section !== null && last !== null) section.removeChild(last);
    const after = buildSnapshot({ mode: SnapshotMode.FULL }).tree;
    expect(before).not.toBe(after);
    expect(after).not.toContain('Beta');
  });

  it('keeps interactive mode lean: omits generic text content', () => {
    render('<div>JustText</div><button>Go</button>');
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).not.toContain('JustText');
    expect(snap.tree).toContain('button "Go"');
  });

  it('emits a layout signature for grid containers so a CLS/layout regression is visible', () => {
    // A layout regression (column count change) leaves the role+text tree identical — only
    // the computed layout differs. The signature makes that visible (a11y-only tools cannot).
    render('<div style="display:grid;grid-template-columns:1fr 1fr"><span>a</span></div>');
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.tree).toContain('grid-cols:');
  });

  it('the layout signature changes when grid columns change (detects the regression)', () => {
    render('<main style="display:grid;grid-template-columns:1fr 1fr"><span>x</span></main>');
    const before = buildSnapshot({ mode: SnapshotMode.FULL }).tree;
    const main = document.querySelector('main');
    if (main instanceof HTMLElement) main.style.gridTemplateColumns = '1fr 1fr 1fr';
    const after = buildSnapshot({ mode: SnapshotMode.FULL }).tree;
    expect(before).not.toBe(after);
  });

  it('omits the layout signature in interactive mode (kept lean)', () => {
    render('<div style="display:grid;grid-template-columns:1fr 1fr"><button>Go</button></div>');
    const snap = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(snap.tree).not.toContain('grid-cols:');
  });
});

describe('query', () => {
  beforeEach(() => {
    render(`
      <button>Pay</button>
      <button disabled>Submit</button>
      <div role="dialog" aria-label="Order confirmed">Done</div>
    `);
  });

  it('matches by role + name', () => {
    const result = matchQuery({ role: 'button', name: 'Pay' });
    expect(result.matched).toBe(true);
    expect(result.elements[0]?.name).toBe('Pay');
  });

  it('filters by state', () => {
    const enabled = matchQuery({ role: 'button', name: 'Submit' }, ElementState.ENABLED);
    expect(enabled.matched).toBe(false);
    const disabled = matchQuery({ role: 'button', name: 'Submit' }, ElementState.DISABLED);
    expect(disabled.matched).toBe(true);
  });

  it('matches a dialog by role', () => {
    expect(matchQuery({ role: 'dialog' }).matched).toBe(true);
  });

  it('honors name in the by+value form (regression)', () => {
    // by:'role'+value:'button'+name must not return every button.
    const result = matchQuery({ by: 'role', value: 'button', name: 'Pay' });
    expect(result.count).toBe(1);
    expect(result.elements[0]?.name).toBe('Pay');
  });

  it('matches testid exactly, not as a substring (regression)', () => {
    document.body.innerHTML =
      '<div data-testid="toast">t</div><button data-testid="show-toast">b</button>';
    // "toast" must NOT also match "show-toast".
    expect(matchQuery({ by: 'testid', value: 'toast' }).count).toBe(1);
    expect(matchQuery({ testid: 'toast' }).elements[0]?.role).toBe('generic');
  });
});

describe('query empty hint', () => {
  beforeEach(() => {
    render('');
  });

  it('returns presentTestids containing other testids on a zero-match query', () => {
    render('<div data-testid="cart-list"></div><div data-testid="cart-total"></div>');
    const r = runQuery({ role: 'button', name: 'Checkout' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.presentTestids).toEqual(expect.arrayContaining(['cart-list', 'cart-total']));
  });

  it('omits the hint on a successful match (shape unchanged)', () => {
    render('<button>Pay</button>');
    const r = runQuery({ role: 'button', name: 'Pay' });
    expect(r.elements.length).toBeGreaterThan(0);
    expect(r.hint).toBeUndefined();
  });

  it('flags knownEmptyState when a registered testid is present', () => {
    registerCapabilities({ testids: ['cart-empty-region'] });
    render('<div data-testid="cart-empty-region">No items</div>');
    const r = runQuery({ by: 'testid', value: 'no-such-id' });
    expect(r.hint?.knownEmptyState).toBe(true);
  });

  it('reports knownEmptyState false when present testids are not registered', () => {
    render('<div data-testid="f4-unregistered-thing"></div>');
    const r = runQuery({ by: 'testid', value: 'no-such-id' });
    expect(r.hint?.knownEmptyState).toBe(false);
  });

  it('caps presentTestids at 12 and de-dupes', () => {
    render(
      Array.from({ length: 20 }, (_, i) => `<div data-testid="t${i}"></div>`).join('') +
        '<div data-testid="t0"></div>',
    );
    const r = runQuery({ role: 'button', name: 'nope' });
    expect(r.hint?.presentTestids).toHaveLength(12);
  });

  it('reflects location in route', () => {
    history.pushState({}, '', '/cart?x=1');
    const r = runQuery({ role: 'button', name: 'nope' });
    expect(r.hint?.route).toBe('/cart?x=1');
  });
});

describe('actions', () => {
  it('clicks a button via its ref', () => {
    render('<button>Go</button>');
    const button = document.querySelector('button') as HTMLButtonElement;
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    const ref = refs.refFor(button);
    void executeAction(ref, 'click');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('fills an input and dispatches input/change', () => {
    render('<input />');
    const input = document.querySelector('input') as HTMLInputElement;
    const onInput = vi.fn();
    input.addEventListener('input', onInput);
    const ref = refs.refFor(input);
    void executeAction(ref, 'fill', { value: '4242' });
    expect(input.value).toBe('4242');
    expect(onInput).toHaveBeenCalled();
  });

  it('rejects with a clear error for a stale ref', async () => {
    render('<button>A</button>');
    const button = document.querySelector('button') as HTMLButtonElement;
    const ref = refs.refFor(button);
    button.remove();
    await expect(executeAction(ref, 'click')).rejects.toThrow(/no longer resolves/);
  });
});
