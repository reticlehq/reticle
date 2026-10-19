import { describe, it, expect } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installDom } from './dom.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function record(mutate: () => void): Promise<Captured[]> {
  const events: Captured[] = [];
  const teardown = installDom((type, data) => events.push({ type, data }));
  mutate();
  await flushMutations();
  teardown();
  return events;
}

const textEvents = (events: Captured[]): Captured[] =>
  events.filter((e) => e.type === EventType.DOM_TEXT);

/**
 * Updating text is the most common visible thing an app does, and it was invisible.
 *
 * `characterData` fires only when an EXISTING text node's `data` is edited in place. Every ordinary
 * way of setting text — `textContent`, `innerText`, appending a text node, React replacing a child —
 * REPLACES the node instead, which arrives as a childList mutation carrying a `Text` node. The
 * childList loops skipped those with `if (!(node instanceof Element)) continue`.
 *
 * Measured on a live page before the fix: `firstChild.data = x` emitted `dom.text`, while
 * `textContent`, `innerText` and `appendChild(createTextNode())` emitted NOTHING. So a grid cell
 * going "pending" → "approved" produced no event, `reticle_observe` answered "nothing happened" over
 * a screen that had visibly changed, and `settled` went quiet instantly because quiet is exactly
 * what it tests for.
 */
describe('a text change is observed however the app makes it', () => {
  it('textContent = x (replaces the text node)', async () => {
    // Wrapped in a real table: a bare <td> is dropped by the HTML parser.
    document.body.innerHTML =
      '<table><tbody><tr><td data-testid="status">pending</td></tr></tbody></table>';
    const cell = document.querySelector('td') as HTMLElement;
    const events = await record(() => {
      cell.textContent = 'approved';
    });
    const texts = textEvents(events);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.data['text']).toBe('approved');
    expect(texts[0]?.data['old']).toBe('pending');
  });

  it('innerText = x', async () => {
    document.body.innerHTML = '<p>before</p>';
    const p = document.querySelector('p') as HTMLElement;
    const events = await record(() => {
      p.textContent = 'after'; // jsdom has no innerText; the node-replacing path is the same
    });
    expect(textEvents(events)[0]?.data['text']).toBe('after');
  });

  it('appending a text node to an existing element', async () => {
    document.body.innerHTML = '<span>a</span>';
    const span = document.querySelector('span') as HTMLElement;
    const events = await record(() => {
      span.appendChild(document.createTextNode('b'));
    });
    expect(textEvents(events)[0]?.data['text']).toBe('ab');
  });

  it('editing an existing text node in place still works (the original path)', async () => {
    document.body.innerHTML = '<span>one</span>';
    const span = document.querySelector('span') as HTMLElement;
    const events = await record(() => {
      const node = span.firstChild as Text;
      node.data = 'two';
    });
    expect(textEvents(events)[0]?.data['text']).toBe('two');
  });

  it('clearing text reports what is on screen NOW, not what left', async () => {
    document.body.innerHTML = '<span>gone soon</span>';
    const span = document.querySelector('span') as HTMLElement;
    const events = await record(() => {
      span.textContent = '';
    });
    const first = textEvents(events)[0];
    expect(first?.data['text']).toBe('');
    expect(first?.data['old']).toBe('gone soon');
  });

  it('does NOT fire on whitespace-only reshuffling', async () => {
    // A re-render that only moves indentation would otherwise emit a text change per layout node —
    // noise the timeline cannot afford, and the opposite failure to the one being fixed.
    document.body.innerHTML = '<div><span>x</span></div>';
    const div = document.querySelector('div') as HTMLElement;
    const events = await record(() => {
      div.insertBefore(document.createTextNode('\n  '), div.firstChild);
    });
    expect(textEvents(events)).toHaveLength(0);
  });

  it('does not fire for Reticle’s own overlay', async () => {
    document.body.innerHTML = '<div data-reticle-overlay><span>panel</span></div>';
    const panel = document.querySelector('span') as HTMLElement;
    const events = await record(() => {
      panel.textContent = 'updated';
    });
    expect(textEvents(events)).toHaveLength(0);
  });
});

/**
 * A stale page: the store changed, the text that shows it did not. To see that, a text change has
 * to say WHICH element (its testid), and the text an element arrived with has to be on record, or
 * "never changed" and "never shown" look the same.
 */
describe('text is named, and its first value is kept', () => {
  it('tags a change with the nearest testid', async () => {
    document.body.innerHTML = '<div data-testid="total"><span>$80</span></div>';
    const span = document.querySelector('span') as HTMLElement;
    const events = await record(() => {
      span.textContent = '$100';
    });
    expect(textEvents(events)[0]?.data).toMatchObject({ text: '$100', testid: 'total' });
  });

  it('reports the text a testid element arrives with', async () => {
    document.body.innerHTML = '<main></main>';
    const events = await record(() => {
      const main = document.querySelector('main') as HTMLElement;
      main.innerHTML = '<p data-testid="score">Score: 3</p>';
    });
    expect(textEvents(events)).toContainEqual({
      type: EventType.DOM_TEXT,
      data: { text: 'Score: 3', testid: 'score', initial: true },
    });
  });
});
