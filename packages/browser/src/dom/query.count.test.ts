import { describe as suite, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TRANSPORT_LIMITS } from '@reticlehq/core';
import { matchQuery, runQuery } from './query.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

suite(
  'a state-filtered query resolves visibility once per element, not per ancestor per sibling',
  () => {
    it('is correct AND does not re-walk shared ancestors for every candidate', () => {
      // 30 buttons nested 8 levels deep under a shared chain. Without the per-call memo, isVisible would
      // force getComputedStyle for every ancestor of every candidate (≈30×8). The memo caches each
      // ancestor once, so the total is bounded near (candidates + unique ancestors), far below the product.
      const depth = 8;
      let html = '';
      for (let i = 0; i < depth; i += 1) html += `<div>`;
      html += Array.from(
        { length: 30 },
        (_v, i) => `<button data-testid="row">b${String(i)}</button>`,
      ).join('');
      for (let i = 0; i < depth; i += 1) html += `</div>`;
      document.body.innerHTML = html;

      const spy = vi.spyOn(window, 'getComputedStyle');
      const result = matchQuery({ by: 'testid', value: 'row' }, 'visible');

      expect(result.count).toBe(30); // every visible match counted — correctness preserved
      // 30 candidates × (8 ancestors + self) would be ~270 without the memo; with it, each unique node's
      // style resolves at most once. Assert we are well under the naive product.
      expect(spy.mock.calls.length).toBeLessThan(30 * depth);
    });

    it('still filters out a hidden candidate whose ancestor is display:none', () => {
      document.body.innerHTML =
        '<div style="display:none"><button data-testid="row">hidden</button></div>' +
        '<div><button data-testid="row">shown</button></div>';
      const result = matchQuery({ by: 'testid', value: 'row' }, 'visible');
      expect(result.count).toBe(1); // only the shown one — inherited visibility via the memo is correct
    });
  },
);

function renderButtons(n: number): void {
  document.body.innerHTML = Array.from(
    { length: n },
    (_v, i) => `<button data-testid="row-action">row ${String(i)}</button>`,
  ).join('');
}

/**
 * "How many of these are on the page?" has to be exact even when the list of them is not, because the
 * two travel together and the agent cannot tell a capped list from a complete one without the count.
 *
 * The server reports totals from `count` rather than `elements.length` for exactly this reason — but
 * runQuery used to drop `count` on the floor, so for the one tool that matters the server fell back to
 * counting survivors and calling it the answer. These tests pin the whole path, not just the shape.
 */
suite('a query counts every match and describes a bounded prefix', () => {
  const CAP = TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS;

  it('counts all matches even when far more exist than are described', () => {
    renderButtons(CAP * 3);
    const result = matchQuery({ by: 'testid', value: 'row-action' });
    expect(result.count).toBe(CAP * 3);
  });

  it('describes no more than the transport can carry', () => {
    renderButtons(CAP * 3);
    expect(matchQuery({ by: 'testid', value: 'row-action' }).elements.length).toBeLessThanOrEqual(
      CAP,
    );
  });

  it('runQuery carries the count through — the server reports totals from it', () => {
    renderButtons(CAP * 3);
    const result = runQuery({ by: 'testid', value: 'row-action' });
    expect(result.count).toBe(CAP * 3);
    expect(result.elements.length).toBeLessThanOrEqual(CAP);
  });

  it('honours a caller limit below the cap', () => {
    renderButtons(50);
    const result = runQuery({ by: 'testid', value: 'row-action' }, 5);
    expect(result.elements).toHaveLength(5);
    expect(result.count).toBe(50);
  });

  it('still reports matched:false and a hint when nothing matches', () => {
    renderButtons(3);
    const result = runQuery({ by: 'testid', value: 'nope' });
    expect(result.count).toBe(0);
    expect(result.elements).toHaveLength(0);
    expect(result.hint).toBeDefined();
  });
});

suite('a missing scope fails closed with scopeMissing, never a silent whole-page search', () => {
  it('flags scopeMissing and returns NO matches when the scope selector matches nothing', () => {
    // The element EXISTS on the page, but not inside the (absent) scope. The old code fell back to
    // document.body and returned it — a phantom match from an unrelated region.
    document.body.innerHTML = '<button data-testid="save">Save</button>';
    const result = matchQuery({ by: 'testid', value: 'save', scope: '#modal-that-is-gone' });
    expect(result.matched).toBe(false);
    expect(result.count).toBe(0);
    expect(result.scopeMissing).toBe(true);
  });

  it('does NOT set scopeMissing when the scope resolves (normal scoped search)', () => {
    document.body.innerHTML = '<div id="panel"><button data-testid="save">Save</button></div>';
    const result = matchQuery({ by: 'testid', value: 'save', scope: '#panel' });
    expect(result.matched).toBe(true);
    expect(result.scopeMissing).toBeUndefined();
  });

  it('does NOT set scopeMissing for an unscoped query that simply finds nothing', () => {
    document.body.innerHTML = '<button data-testid="save">Save</button>';
    const result = matchQuery({ by: 'testid', value: 'nope' });
    expect(result.matched).toBe(false);
    expect(result.scopeMissing).toBeUndefined(); // absent element ≠ missing scope
  });

  it('runQuery carries scopeMissing through to the tool result', () => {
    document.body.innerHTML = '<button data-testid="save">Save</button>';
    const result = runQuery({ by: 'testid', value: 'save', scope: '#gone' });
    expect(result.scopeMissing).toBe(true);
    expect(result.count).toBe(0);
  });
});
