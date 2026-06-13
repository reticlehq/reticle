import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementState, SnapshotMode } from '@iris/protocol';
import { getAccessibleName, getRole, getStates } from './a11y.js';
import { buildSnapshot } from './snapshot.js';
import { matchQuery } from './query.js';
import { executeAction } from './actions.js';
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

  it('throws a clear error for a stale ref', () => {
    render('<button>A</button>');
    const button = document.querySelector('button') as HTMLButtonElement;
    const ref = refs.refFor(button);
    button.remove();
    expect(() => executeAction(ref, 'click')).toThrow(/no longer resolves/);
  });
});
