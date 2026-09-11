import { describe, expect, it, beforeEach } from 'vitest';
import { SnapshotMode } from '@reticlehq/core';
import { buildSnapshot } from './snapshot.js';

/**
 * #397: a focus-trap modal aria-hides every sibling of its portal, and the snapshot walk correctly
 * skips aria-hidden subtrees -- so a whole-page snapshot can come back with only the overlay and
 * nothing else, indistinguishable from an empty page. When the rest of the page is entirely
 * aria-hidden behind a visible overlay, status says so instead of returning a near-empty tree with
 * no explanation.
 */
describe('overlayHidingPage status (#397)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports when the page outside a visible modal is entirely aria-hidden', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><button>Buy now</button><a href="/x">Home</a></div>' +
      '<div><div role="dialog" aria-label="Confirm"><button>OK</button></div></div>';
    const { status } = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(status.overlayHidingPage).toBeDefined();
    expect(String(status.overlayHidingPage)).toContain('overlay');
  });

  it('says nothing on a normal page with a dialog but no hidden siblings', () => {
    document.body.innerHTML =
      '<div><button>Buy now</button></div>' +
      '<div role="dialog" aria-label="Confirm"><button>OK</button></div>';
    const { status } = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(status.overlayHidingPage).toBeUndefined();
    // The dialog itself is still surfaced normally.
    expect(status.visibleDialogs).toContain('Confirm');
  });

  it('says nothing when there is no dialog at all, even if a sibling is aria-hidden', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><button>Hidden</button></div>' +
      '<div><button>Visible</button></div>';
    const { status } = buildSnapshot({ mode: SnapshotMode.INTERACTIVE });
    expect(status.overlayHidingPage).toBeUndefined();
  });
});
