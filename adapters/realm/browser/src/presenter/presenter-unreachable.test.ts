import { describe, expect, it, beforeEach } from 'vitest';
import { Presenter } from './presenter.js';

/**
 * An instrumented page whose bridge is dead used to look EXACTLY like a page with no Reticle in it:
 * the overlay mounted, the dock stayed off, and nothing on screen said why. That is the same
 * "silence reads as clean" failure the verdict layer refuses everywhere else, pointed at the user
 * instead of the agent — they cannot tell "I forgot to start the daemon" from "the install failed".
 */
describe('a bridge that never answered', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.querySelectorAll('style[data-reticle-overlay]').forEach((s) => s.remove());
  });

  const mount = (): Presenter => {
    const p = new Presenter();
    p.mount();
    return p;
  };

  const dockOn = (): string | null =>
    document.querySelector('[data-reticle-dock]')?.getAttribute('data-on') ?? null;

  it('is invisible before anything is known, so an idle page is not decorated', () => {
    mount();
    expect(dockOn()).not.toBe('1');
  });

  it('shows the HUD when the bridge could not be reached', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    expect(dockOn()).toBe('1');
  });

  it('says in plain words what is wrong and what to do, with the url kept on hover', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    const act = document.querySelector('.reticle-act');
    const text = act?.textContent ?? '';
    // A raw "no bridge at ws://…" told a first-time user nothing they could act on.
    expect(text).not.toContain('ws://');
    expect(text).toContain("Can't reach Reticle");
    expect(text).toContain('reticle serve');
    // The technical detail stays one hover away: the port is still the usual answer.
    expect(act?.getAttribute('title') ?? '').toContain('ws://localhost:4460/reticle');
  });

  it('drops the hover detail once a live action replaces the message', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    p.sessionStart();
    p.status('clicked Save');
    expect(document.querySelector('.reticle-act')?.hasAttribute('title')).toBe(false);
  });

  it('marks itself unreachable rather than posing as a live session', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    expect(
      document.querySelector('div[data-reticle-overlay]')?.getAttribute('data-reticle-state'),
    ).toBe('unreachable');
    expect(p.sessionActive).toBe(false);
  });

  it('gives way the moment a bridge does answer', () => {
    const p = mount();
    p.showUnreachable('ws://localhost:4460/reticle', 3);
    p.sessionStart();
    expect(p.sessionActive).toBe(true);
    expect(
      document.querySelector('div[data-reticle-overlay]')?.getAttribute('data-reticle-state'),
    ).not.toBe('unreachable');
  });
});
