import { describe, it, expect } from 'vitest';
import { EventType } from '@syrin/iris-protocol';
import { installDom } from '../observers/dom.js';
import { executeAction, executeSequence } from './actions.js';
import { refs } from '../dom/refs.js';

interface Collected {
  type: EventType;
  data: Record<string, unknown>;
}

/**
 * Airtight since-causality (settle). After ACT performs the action, executeAction awaits a
 * microtask + one animation frame ("settle") so React's commit (and the MutationObserver records
 * it triggers → dom.text/dom.attr events) flush BEFORE the command result resolves. That means
 * those events have t > since and appear in observe({ since }).
 */
describe('settle: act then observe exactly what it caused', () => {
  // Test A — an in-place text re-render after a click is captured (the dom.text case).
  it('captures an in-place text re-render after a click', async () => {
    document.body.innerHTML = '<button>Inc</button><span id="count">0</span>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const span = document.getElementById('count') as HTMLSpanElement;

    const events: Collected[] = [];
    const teardown = installDom((type, data) => {
      events.push({ type, data });
    });
    // React-style commit-on-click: mutate text in place (characterData), not node replacement.
    button.addEventListener('click', () => {
      if (span.firstChild !== null) span.firstChild.nodeValue = '1';
    });

    try {
      await executeAction(refs.refFor(button), 'click', {});
    } finally {
      teardown();
    }

    const textEvents = events.filter((e) => e.type === EventType.DOM_TEXT);
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.data['text']).toBe('1');
    // It was an in-place re-render, not an add/remove of the count node.
    expect(events.some((e) => e.type === EventType.DOM_ADDED)).toBe(false);
    expect(events.some((e) => e.type === EventType.DOM_REMOVED)).toBe(false);
  });

  // Test C — the mutation event is emitted BEFORE the act promise resolves (causality proof).
  it('resolves the act only after the commit has been observed', async () => {
    document.body.innerHTML = '<button>Inc</button><span id="count">0</span>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const span = document.getElementById('count') as HTMLSpanElement;

    const order: string[] = [];
    const teardown = installDom((type) => {
      if (type === EventType.DOM_TEXT) order.push('mutation');
    });
    button.addEventListener('click', () => {
      if (span.firstChild !== null) span.firstChild.nodeValue = '1';
    });

    try {
      await executeAction(refs.refFor(button), 'click', {});
      order.push('resolved');
    } finally {
      teardown();
    }

    expect(order.indexOf('mutation')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('mutation')).toBeLessThan(order.indexOf('resolved'));
  });

  // Test F — sequence settles between steps: React commits between clicks.
  it('settles between steps in a sequence', async () => {
    document.body.innerHTML = '<button>Inc</button><span id="count">0</span>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const span = document.getElementById('count') as HTMLSpanElement;

    const values: string[] = [];
    const teardown = installDom((type, data) => {
      if (type === EventType.DOM_TEXT) values.push(String(data['text']));
    });
    button.addEventListener('click', () => {
      const node = span.firstChild;
      if (node !== null) node.nodeValue = String(Number(node.nodeValue ?? '0') + 1);
    });

    const ref = refs.refFor(button);
    try {
      await executeSequence([
        { ref, action: 'click' },
        { ref, action: 'click' },
      ]);
    } finally {
      teardown();
    }

    expect(values).toEqual(['1', '2']);
  });
});
