/**
 * Persona drive: while the console's "Copy this now" dialog was open, `reticle_look { page }`
 * returned an empty tree (nodes 0) and the agent could neither read the dialog nor press Copy key.
 * A second overlay had stamped the dialog's own portal aria-hidden (as Radix's `aria-hidden` package
 * does to every sibling), so the walk skipped the one thing on screen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildSnapshot } from './snapshot.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a dialog an overlay stamped aria-hidden', () => {
  it('is what the snapshot shows when nothing else is', () => {
    document.body.innerHTML =
      '<div aria-hidden="true" data-aria-hidden="true"><main><button>Create key</button></main></div>' +
      '<div aria-hidden="true" data-aria-hidden="true"><div role="dialog" aria-modal="true" aria-label="Copy this now">' +
      '<button>Copy key</button></div></div>';
    const snap = buildSnapshot({});
    expect(snap.tree).toContain('Copy key');
    expect(snap.tree).not.toContain('Create key');
  });

  it('leaves a page with an ordinary modal as it was: only the dialog', () => {
    document.body.innerHTML =
      '<div aria-hidden="true" data-aria-hidden="true"><button>Behind</button></div>' +
      '<div><div role="dialog" aria-label="Edit"><button>Save</button></div></div>';
    const snap = buildSnapshot({});
    expect(snap.tree).toContain('Save');
    expect(snap.tree).not.toContain('Behind');
  });
});
