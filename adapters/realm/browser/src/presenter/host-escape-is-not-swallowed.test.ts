/**
 * Escape belongs to the app whenever the app has something open that Escape closes.
 *
 * The HUD listens for Escape on `document` and calls `preventDefault()` on it. Reported from the
 * field (#995): open a `<dialog>` with `showModal()`, press Escape, and nothing happens — the
 * cancelled close request is Reticle's, so a developer testing their own modal in dev sees a bug
 * that does not exist in production. The same cancellation silences every library modal that
 * refuses to dismiss an event another handler already answered.
 *
 * These tests use CANCELABLE events and real host listeners, because `defaultPrevented` is the
 * whole of the defect: a test that only asserts the HUD's own attributes cannot see it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Presenter } from './presenter.js';
import { CHAT_ATTR, MIN_ATTR } from './presenter-config.js';

const HUD_MOUNT_TIMEOUT_MS = 30_000;

let live: Presenter | undefined;
/**
 * The app's listeners, torn down between tests.
 *
 * One jsdom document serves the whole file, so a `document` listener left behind outlives the test
 * that added it. The capture-phase one below cancels every Escape, and leaking it made four later
 * tests assert the fix while measuring the leak.
 */
let host: AbortController | undefined;

/** Register a listener the way the app under test would: on `document`, and never removed by us. */
function onHostKeydown(handler: (e: KeyboardEvent) => void, capture = false): void {
  host ??= new AbortController();
  document.addEventListener('keydown', handler, { capture, signal: host.signal });
}

afterEach(() => {
  live?.destroy();
  live = undefined;
  host?.abort();
  host = undefined;
  document.querySelectorAll('[data-reticle-overlay]').forEach((e) => e.remove());
  document.body.innerHTML = '';
});

/** A session with the HUD expanded — which also opens the chat, so both branches are armed. */
function expandedHud(): HTMLElement {
  document.body.innerHTML = '';
  const p = new Presenter({});
  live = p;
  p.mount();
  p.sessionStart();
  const fab = document.querySelector('[data-reticle-fab]');
  fab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const overlay = document.querySelector<HTMLElement>('div[data-reticle-overlay]');
  if (null === overlay) throw new Error('the HUD did not mount');
  expect(overlay.getAttribute(CHAT_ATTR), 'chat opens with the HUD').toBe('1');
  expect(overlay.getAttribute(MIN_ATTR), 'the HUD is expanded').toBe('0');
  return overlay;
}

/** What a browser actually sends: cancelable, bubbling, from the element that has focus. */
function pressEscape(from: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  from.dispatchEvent(event);
  return event;
}

/** A native modal, as `showModal()` leaves the DOM. jsdom has no top layer and no `showModal`. */
function appDialog(): HTMLButtonElement {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  const ok = document.createElement('button');
  ok.textContent = 'OK';
  dialog.appendChild(ok);
  document.body.appendChild(dialog);
  return ok;
}

describe('Escape while the app has a dialog open', { timeout: HUD_MOUNT_TIMEOUT_MS }, () => {
  it('leaves the close request for the native <dialog> uncancelled', () => {
    const overlay = expandedHud();
    const ok = appDialog();

    const event = pressEscape(ok);

    expect(event.defaultPrevented, 'the browser still gets to close the dialog').toBe(false);
    expect(overlay.getAttribute(CHAT_ATTR), 'the HUD did not answer the key').toBe('1');
    expect(overlay.getAttribute(MIN_ATTR), 'and did not collapse either').toBe('0');
  });

  it('lets a library modal that gates on defaultPrevented dismiss itself', () => {
    const overlay = expandedHud();
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.textContent = 'Delete workspace?';
    document.body.appendChild(modal);
    // Registered AFTER the HUD, on document, exactly as a portalled layer mounts: same target, same
    // phase, so the HUD's handler runs first and this one sees whatever it left behind.
    let dismissed = false;
    onHostKeydown((e) => {
      if ('Escape' !== e.key || e.defaultPrevented) return;
      dismissed = true;
    });

    pressEscape(modal);

    expect(dismissed, 'the app layer is the one that owns this key').toBe(true);
    expect(overlay.getAttribute(CHAT_ATTR), 'the HUD did not answer it too').toBe('1');
  });

  it('collapses nothing when the HUD is expanded with the chat already closed', () => {
    const overlay = expandedHud();
    overlay.querySelector<HTMLElement>('[data-reticle-chat-toggle]')?.click();
    expect(overlay.getAttribute(CHAT_ATTR), 'chat closed by its toggle').toBeNull();
    const ok = appDialog();

    const event = pressEscape(ok);

    expect(event.defaultPrevented, 'collapsing the HUD is not worth the key').toBe(false);
    expect(overlay.getAttribute(MIN_ATTR), 'the HUD stays as it was').toBe('0');
  });
});

describe('Escape that another handler already answered', { timeout: HUD_MOUNT_TIMEOUT_MS }, () => {
  it('is left alone once the app has called preventDefault', () => {
    const overlay = expandedHud();
    const page = document.createElement('button');
    document.body.appendChild(page);
    onHostKeydown((e) => {
      if ('Escape' === e.key) e.preventDefault();
    }, true);

    pressEscape(page);

    expect(overlay.getAttribute(CHAT_ATTR), 'one press, one response').toBe('1');
    expect(overlay.getAttribute(MIN_ATTR)).toBe('0');
  });
});

describe('Escape that the HUD still owns', { timeout: HUD_MOUNT_TIMEOUT_MS }, () => {
  it('closes the chat, and says so, when the app has nothing open', () => {
    const overlay = expandedHud();

    const event = pressEscape(document.body);

    expect(overlay.getAttribute(CHAT_ATTR), 'Escape is still a way out of the chat').toBeNull();
    expect(event.defaultPrevented, 'the HUD handled it, so it claims it').toBe(true);
  });

  it('collapses the HUD when the chat is already closed and the app has nothing open', () => {
    const overlay = expandedHud();
    overlay.querySelector<HTMLElement>('[data-reticle-chat-toggle]')?.click();

    const event = pressEscape(document.body);

    expect(overlay.getAttribute(MIN_ATTR), 'Escape is still the way out of the HUD').toBe('1');
    expect(event.defaultPrevented).toBe(true);
  });

  it('is not disarmed by a <dialog> that is in the DOM but closed', () => {
    const overlay = expandedHud();
    const dialog = document.createElement('dialog');
    dialog.appendChild(document.createElement('button'));
    document.body.appendChild(dialog);

    pressEscape(document.body);

    expect(overlay.getAttribute(CHAT_ATTR), 'a closed dialog owns no key').toBeNull();
  });

  it('is not disarmed by a hidden role=dialog left mounted by its library', () => {
    const overlay = expandedHud();
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.style.display = 'none';
    document.body.appendChild(modal);

    pressEscape(document.body);

    expect(overlay.getAttribute(CHAT_ATTR), 'a hidden layer owns no key').toBeNull();
  });

  it('is not disarmed by dialog-shaped chrome that belongs to Reticle', () => {
    const overlay = expandedHud();
    const ours = document.createElement('div');
    ours.setAttribute('data-reticle-tour', '');
    const card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    ours.appendChild(card);
    document.body.appendChild(ours);

    pressEscape(document.body);

    expect(overlay.getAttribute(CHAT_ATTR), 'our own chrome is not the app').toBeNull();
  });

  it('still answers a press that came from inside the HUD while an app dialog is open', () => {
    const overlay = expandedHud();
    appDialog();
    const toggle = overlay.querySelector('[data-reticle-chat-toggle]');
    if (null === toggle) throw new Error('the chat toggle is missing');

    const event = pressEscape(toggle);

    expect(overlay.getAttribute(CHAT_ATTR), 'the key was pressed in our UI').toBeNull();
    expect(event.defaultPrevented, 'and we answered it').toBe(true);
  });
});
