import { describe, it, expect } from 'vitest';
import { Presenter } from './presenter.js';
import { buildSnapshot } from './snapshot.js';
import { isIgnored } from './dom-ignore.js';

describe('presenter / transparency layer', () => {
  it('mounts an overlay that is excluded from snapshots, then narrates + destroys', () => {
    document.body.innerHTML = '<button>Save</button>';
    const p = new Presenter({ paceMs: 0 });
    p.mount();

    const hud = document.querySelector('[data-iris-hud]');
    expect(hud).not.toBeNull();
    expect(isIgnored(hud as Element)).toBe(true);

    // The HUD's "idle"/"Save" text must NOT leak into the page snapshot.
    const snap = buildSnapshot({ mode: 'full' });
    expect(snap.tree).toContain('button "Save"');
    expect(snap.tree).not.toContain('idle');

    p.narrate('Clicking Save to verify the flow');
    expect(document.querySelector('[data-iris-hud] .iris-note')?.textContent).toContain(
      'Clicking Save',
    );

    p.destroy();
    expect(document.querySelector('[data-iris-overlay]')).toBeNull();
  });
});
