/**
 * Escape belongs to the app under test, not to our panel (#995).
 *
 * Reported from the field: "A document-level keydown listener in the SDK calls preventDefault() on
 * Escape. That cancels the browser's close request for a <dialog> opened with showModal(), so
 * Escape does not close the app's modals in dev." Two steps to reproduce, and what the developer
 * sees is a bug in their own modal that does not exist in production.
 *
 * An instrumentation layer observes; it does not participate. `preventDefault` on an event the app
 * is entitled to act on is participating in the strongest possible way - it takes the event away.
 * And the branch that did it most was the broadest one: with the HUD expanded, which is the
 * default, EVERY Escape anywhere on the page was cancelled so that our own panel could collapse.
 *
 * Two rules, and the second is not redundant. Never cancel the event. And when the app has a modal
 * open, do not act at all: Escape then unambiguously belongs to the modal, and collapsing our panel
 * at the same moment is a second surprise on top of the first.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { Presenter } from './presenter.js';
import { CHAT_ATTR, MIN_ATTR } from './presenter-config.js';
import { mountTour } from './tour/tour.js';

const HUD_TIMEOUT_MS = 30_000;
const overlay = () => document.querySelector('div[data-reticle-overlay]');

const pressEscape = (): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
};

describe('Escape and the app under test', { timeout: HUD_TIMEOUT_MS }, () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is never cancelled, so the browser can still close a native dialog', () => {
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    // The default state the report was filed against: HUD expanded, nothing of ours focused.
    expect(overlay()?.getAttribute(MIN_ATTR)).not.toBe('1');
    const event = pressEscape();
    expect(
      event.defaultPrevented,
      'cancelling Escape is what stops <dialog> closing — the reported defect',
    ).toBe(false);
    p.destroy();
  });

  it('leaves Escape alone entirely while the app has a modal open', () => {
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);
    const before = overlay()?.getAttribute(CHAT_ATTR);

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(false);
    expect(
      overlay()?.getAttribute(CHAT_ATTR),
      'the panel reacted to an Escape the app had every right to',
    ).toBe(before ?? null);
    p.destroy();
  });

  /*
   * #1019 (DivyamTalwar): the native-dialog check missed every React modal library. Radix, MUI and
   * headless-ui render a `role="dialog"` element with `aria-modal="true"`, not a `<dialog>`.
   */
  it('leaves Escape alone while an aria-modal dialog from a component library is open', () => {
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    document.querySelector<HTMLElement>('[data-reticle-fab]')?.click();
    expect(overlay()?.getAttribute(CHAT_ATTR)).toBe('1');
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    pressEscape();

    expect(overlay()?.getAttribute(CHAT_ATTR), "our chat closed on the modal's Escape").toBe('1');
    p.destroy();
  });

  it('leaves an Escape the app already handled to the app', () => {
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    document.querySelector<HTMLElement>('[data-reticle-fab]')?.click();
    const handled = (e: KeyboardEvent): void => {
      if ('Escape' === e.key) e.preventDefault();
    };
    document.body.addEventListener('keydown', handled);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    document.body.removeEventListener('keydown', handled);
    expect(overlay()?.getAttribute(CHAT_ATTR)).toBe('1');
    p.destroy();
  });

  it('does not count a hidden aria-modal element as an open modal', () => {
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    document.querySelector<HTMLElement>('[data-reticle-fab]')?.click();
    const kept = document.createElement('div');
    kept.setAttribute('aria-modal', 'true');
    kept.hidden = true;
    document.body.appendChild(kept);
    pressEscape();
    expect(overlay()?.getAttribute(CHAT_ATTR)).toBeNull();
    p.destroy();
  });

  /* The feature itself survives: with no modal in the way, Escape still closes our chat. */
  it('still closes the chat when nothing in the app wants the key', () => {
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    // Expanded by hand, the way the shell's own suite does it.
    document.querySelector<HTMLElement>('[data-reticle-fab]')?.click();
    expect(overlay()?.getAttribute(CHAT_ATTR)).toBe('1');
    pressEscape();
    expect(overlay()?.getAttribute(CHAT_ATTR)).toBeNull();
    p.destroy();
  });
});

/*
 * The handler that was ACTUALLY biting, and only driving found it.
 *
 * The shell fix above was necessary and not sufficient: with the shell fixed and the SDK rebuilt, a
 * real browser still left the dialog open. Tracing `preventDefault` from inside the page named
 * `tour.js` — the first-connect tour, which cancels Escape to close itself.
 *
 * That is the reporter's repro exactly, including the part that looked like noise: "after a click
 * inside the dialog it works again". A click dismisses the tour, and from then on Escape reaches
 * the app.
 */
describe('the tour and an app modal', () => {
  const storage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string): string | null => map.get(k) ?? null,
      setItem: (k: string, v: string): void => void map.set(k, v),
    };
  };
  const deps = () => ({
    document,
    storage: storage(),
    projectId: 'proj',
    isDriving: () => false,
    search: '',
    navigator: { webdriver: false } as Navigator,
  });

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not take Escape while the app has a modal open', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);
    const handle = mountTour(deps());
    expect(handle, 'the tour must actually be up, or this asserts nothing').toBeDefined();

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(false);
    handle?.destroy();
  });

  /* And with no modal in the way it still closes itself, which is why it listens at all. */
  it('still closes itself on Escape when nothing else wants the key', () => {
    const handle = mountTour(deps());
    expect(handle).toBeDefined();
    const event = pressEscape();
    expect(event.defaultPrevented).toBe(true);
    handle?.destroy();
  });
});
