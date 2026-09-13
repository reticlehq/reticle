/**
 * An empty tree over a crashed app looked exactly like an empty tree over a slow one.
 *
 * Filed from the field alongside the react-three-fiber crash: the `data-reticle-source` stamp threw
 * inside R3F's commit phase, React unmounted the whole tree, and the page went white.
 * `reticle_snapshot` answered `{ tree: "", nodes: 0 }` — the same answer it gives a page that has
 * not rendered yet — and the reporter spent a diagnosis pass establishing which one it was. Their
 * words: detecting a dead root "would have pointed me at the real cause immediately".
 *
 * This file already answers the same question for the causes it can see: `leanSkipped` and
 * `hiddenSkipped` exist so that an empty tree is a pointer at the READ rather than a claim about the
 * app. The unmounted root is the third cause and the walk could not speak to it, because a walk that
 * visits nothing has nothing to count.
 *
 * So the count is of the DOM, not of the walk: how many elements exist under the scope at all. It is
 * a fact the browser knows for certain and it separates the two cases outright — a handful of
 * elements is a mount container with nothing in it, forty-four is a page whose elements were all
 * skipped. Deliberately a number and not a diagnosis, for the reason `hiddenSkipped` gives.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { buildSnapshot } from './snapshot.js';
import { SnapshotMode } from '@reticlehq/core';

describe('an empty snapshot says how much DOM was actually there', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports an empty mount container, which is what a dead root looks like', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.nodes).toBe(0);
    expect(snap.domElements).toBe(1);
  });

  it('reports zero when the scope holds no elements at all', () => {
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.nodes).toBe(0);
    expect(snap.domElements).toBe(0);
  });

  it('counts the DOM, not the walk, when everything was skipped as hidden', () => {
    // The other cause of an empty tree, and the number has to tell them apart: plenty of DOM here.
    document.body.innerHTML = '<div hidden>' + '<button>a</button>'.repeat(12) + '</div>';
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.nodes).toBe(0);
    expect(snap.domElements).toBeGreaterThan(3);
  });

  it('is absent when the snapshot found something — it explains an EMPTY tree only', () => {
    document.body.innerHTML = '<button>Save</button>';
    const snap = buildSnapshot({ mode: SnapshotMode.FULL });
    expect(snap.nodes).toBeGreaterThan(0);
    expect(snap.domElements).toBeUndefined();
  });

  it('is absent on a status-only read, which never walks anything', () => {
    document.body.innerHTML = '<div id="root"></div>';
    expect(buildSnapshot({ mode: SnapshotMode.STATUS }).domElements).toBeUndefined();
  });
});
