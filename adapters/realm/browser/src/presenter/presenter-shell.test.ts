import { describe, it, expect, afterEach } from 'vitest';
import { Presenter } from './presenter.js';
import { HudShell } from './presenter-shell.js';
import { asSyntheticInput } from '@/actions/synthetic/synthetic-input.js';
import { Annotator } from '@/review/annotator.js';
import { LOG_KIND } from './chrome/presenter-log.js';

const click = (el: Element | null | undefined): void => {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

afterEach(() => {
  document.querySelectorAll('[data-reticle-overlay]').forEach((e) => e.remove());
  document.body.innerHTML = '';
});
/**
 * Every test here mounts a full HUD into jsdom, which is slow, and on a loaded Windows runner it is
 * slow enough to blow vitest's 5s default. The assertions are synchronous, so the timeout was never
 * measuring the product — only the machine, and only when that machine was busy, which is to say
 * only in CI.
 *
 * A bound, not a duration: nothing here asserts how long anything took, and raising the ceiling
 * cannot mask a real failure because a broken expectation still fails immediately.
 */
const HUD_MOUNT_TIMEOUT_MS = 30_000;

describe('presenter HUD shell', { timeout: HUD_MOUNT_TIMEOUT_MS }, () => {
  // #992: the HUD sat outside every landmark, so an instrumented page could never be axe-clean.
  it('is one labelled landmark, so the page it sits on stays axe-clean', () => {
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    const dock = document.querySelector('[data-reticle-dock]');
    expect(dock?.getAttribute('role')).toBe('complementary');
    expect(dock?.getAttribute('aria-label')).toBe('Reticle');
  });

  it('renders six top-level destinations/actions once with one aligned toolbar', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const toolbar = document.querySelector<HTMLElement>('[role="toolbar"]');
    if (null === toolbar) throw new Error('HUD toolbar failed to mount');
    const chrome = toolbar.querySelector('.reticle-toolbar-chrome');
    if (null === chrome) throw new Error('HUD toolbar destinations are missing');
    expect(chrome.querySelectorAll('[data-reticle-chat-view-btn="activity"]')).toHaveLength(1);
    expect(chrome.querySelectorAll('[data-reticle-chat-view-btn="flows"]')).toHaveLength(1);
    expect(chrome.querySelectorAll('[data-reticle-chat-view-btn="annotations"]')).toHaveLength(1);
    expect(chrome.querySelectorAll('[data-reticle-chat-impact]')).toHaveLength(1);
    expect(chrome.querySelectorAll('[data-reticle-annotate-btn]')).toHaveLength(0);
    expect(chrome.querySelectorAll('[data-reticle-settings-btn]')).toHaveLength(1);
    expect(chrome.querySelectorAll('[data-reticle-min-btn]')).toHaveLength(1);
    expect(toolbar.querySelectorAll('[data-reticle-chat-view-btn="annotations"]')).toHaveLength(1);
    expect(toolbar.querySelectorAll('[data-reticle-chat-view="annotations"]')).toHaveLength(0);
    expect(chrome.querySelectorAll('button')).toHaveLength(6);
    expect(chrome.querySelectorAll('svg:not([width="18"][height="18"])')).toHaveLength(0);
    const toolbarGlyphs = Array.from(
      chrome.querySelectorAll('button'),
      (button) => button.querySelector('svg')?.innerHTML,
    );
    expect(new Set(toolbarGlyphs).size).toBe(6);
    const agentPage = document.querySelector('[data-reticle-chat-panel]');
    const flowsPage = document.querySelector('[data-reticle-page-panel="flows"]');
    const notesPage = document.querySelector('[data-reticle-page-panel="annotations"]');
    expect(agentPage?.parentElement).toBe(flowsPage?.parentElement);
    expect(agentPage?.parentElement).toBe(notesPage?.parentElement);
    expect(agentPage?.contains(document.querySelector('[data-reticle-harness-spot]'))).toBe(true);
    expect(flowsPage?.querySelector('[data-reticle-harness-spot]')).toBeNull();
    expect(notesPage?.querySelector('[data-reticle-harness-spot]')).toBeNull();
    expect(agentPage?.querySelector('.reticle-hud-log-well')).not.toBeNull();
    expect(flowsPage?.querySelector('.reticle-hud-log-well')).toBeNull();
    expect(notesPage?.querySelector('.reticle-hud-log-well')).toBeNull();
    p.destroy();
  });

  it('lets Flows, Notes, and Impact receive pointer clicks instead of starting a toolbar drag', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    for (const selector of [
      '[data-reticle-chat-view-btn="flows"]',
      '[data-reticle-chat-view-btn="annotations"]',
      '[data-reticle-chat-impact]',
    ]) {
      const button = document.querySelector(selector);
      if (null === button) throw new Error(`Missing toolbar button: ${selector}`);
      const pointerDown = new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      button.dispatchEvent(pointerDown);
      expect(pointerDown.defaultPrevented, `${selector} must not be captured as a drag`).toBe(
        false,
      );
      document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    }
    p.destroy();
  });

  // Expanding now OPENS the chat rather than revealing a bare toolbar: the chat is the HUD's
  // content, and a toolbar with nothing above it made the agent's log something you had to know to
  // go looking for. The toggle still closes it, which the next assertion covers.
  it('opens agent chat above the toolbar on expand, and closes on Escape', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    expect(overlay?.getAttribute('data-reticle-chat'), 'chat opens with the HUD').toBe('1');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay?.getAttribute('data-reticle-chat')).toBeNull();
    p.destroy();
  });
  it('keeps the agent log dedicated to real activity as rows arrive and are trimmed', () => {
    document.body.innerHTML = '';
    globalThis.sessionStorage.clear();
    const p = new Presenter({ logMax: 3 });
    p.mount();
    const log = document.querySelector('[data-reticle-log]');
    expect(log?.querySelectorAll('[data-reticle-log-row]')).toHaveLength(0);
    expect(log?.querySelector('[data-reticle-carousel]')).toBeNull();
    for (let i = 0; i < 6; i += 1) p.log(LOG_KIND.ACT, `row ${String(i)}`);
    expect(log?.querySelectorAll('[data-reticle-log-row]')).toHaveLength(3);
    p.destroy();
  });
  it('keeps the toolbar expanded while agent chat is open', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    expect(overlay?.getAttribute('data-reticle-min')).toBe('0');
    expect(overlay?.getAttribute('data-reticle-chat')).toBe('1');
    p.destroy();
  });
  it('keeps the toolbar expanded when clicking the page', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    expect(overlay?.getAttribute('data-reticle-min')).toBe('0');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(overlay?.getAttribute('data-reticle-min')).toBe('0');
    p.destroy();
  });
  it('uses polished black surfaces without embedded textures', () => {
    const p = new Presenter({});
    p.mount();
    const css = document.querySelector('style[data-reticle-overlay]')?.textContent ?? '';
    expect(css).toContain('background:#000');
    expect(css).not.toMatch(/data:image\/(?:png|webp|svg\+xml)/);
    p.destroy();
  });
  it('shows edge sheen only on the expanded toolbar, not the collapsed FAB', () => {
    const p = new Presenter({});
    p.mount();
    // `autoOpenChat` defaults ON, so a session now STARTS expanded with the chat open — the HUD's
    // content is the point of the HUD. The sheen is still an expanded-only affordance, so this
    // collapses first to reach the state it is about rather than assuming session start is it.
    p.sessionStart();
    const css = document.querySelector('style[data-reticle-overlay]')?.textContent ?? '';
    expect(css).toContain('[data-reticle-min="0"] [data-reticle-hud] .reticle-hud-deco');
    const deco = document.querySelector<HTMLElement>('.reticle-hud-deco');
    expect(deco).not.toBeNull();
    expect(getComputedStyle(deco as Element).visibility).toBe('visible');
    document.querySelector<HTMLElement>('[data-reticle-min-btn]')?.click();
    expect(getComputedStyle(deco as Element).visibility).toBe('hidden');
    (document.querySelector('[data-reticle-fab]') as HTMLElement).click();
    expect(getComputedStyle(deco as Element).visibility).toBe('visible');
    p.destroy();
  });
  it('keeps the project capsule alone and puts the promo in the rail every page shares', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    expect(
      document.querySelector('.reticle-foot-workspace-row [data-reticle-workspace-btn]'),
    ).not.toBeNull();
    const carousel = document.querySelector('[data-reticle-carousel]');
    expect(carousel?.closest('[data-reticle-rail]')).not.toBeNull();
    expect(carousel?.closest('[data-reticle-log]')).toBeNull();
    // One rail, outside every panel, so no page can lose it.
    const rail = document.querySelector('[data-reticle-rail]');
    expect(document.querySelectorAll('[data-reticle-rail]')).toHaveLength(1);
    expect(rail?.closest('[data-reticle-chat-panel],[data-reticle-page-panel]')).toBeNull();
    p.destroy();
  });
  it('keeps the Agent Log to two rows above the log, ended or not', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const panel = document.querySelector('[data-reticle-chat-panel]');
    // The title is in the header, not a row of its own.
    expect(panel?.querySelector('.reticle-chat-head')?.textContent).toContain('Reticle');
    expect(panel?.querySelector('.reticle-view-heading')).toBeNull();
    // "Session ended" replaces the status text inside the status row rather than adding a row.
    expect(panel?.querySelector('.reticle-act-strip [data-reticle-banner]')).not.toBeNull();
    // The Harness control sits in the footer beside the project capsule.
    expect(panel?.querySelector('[data-reticle-foot] [data-reticle-harness-spot]')).not.toBeNull();
    p.destroy();
  });
  it('gives every page one header row: title, one-line subtitle, actions, close', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    for (const page of ['flows', 'annotations']) {
      const panel = document.querySelector(`[data-reticle-page-panel="${page}"]`);
      // The subtitle lives inside the header rather than as a second bordered row.
      expect(panel?.querySelector('.reticle-page-heading .reticle-page-subtitle')).not.toBeNull();
      expect(panel?.querySelector(':scope > .reticle-page-subtitle')).toBeNull();
    }
    // Settings keeps its links, but in the scrolling body rather than a fixed footer.
    expect(
      document.querySelector('.reticle-settings-body [data-reticle-feedback-call]'),
    ).not.toBeNull();
    p.destroy();
  });
  it("shows a setting's help under its row when the (?) is clicked, and hides it again", () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    click(document.querySelector('[data-reticle-settings-btn]'));
    const help = document.querySelector<HTMLElement>('[data-reticle-settings-help]');
    const row = help?.closest('.reticle-settings-row');
    click(help);
    expect(row?.querySelector('[data-reticle-settings-helptext]')?.textContent).toBe(
      help?.getAttribute('title'),
    );
    expect(help?.getAttribute('aria-expanded')).toBe('true');
    click(help);
    expect(row?.querySelector('[data-reticle-settings-helptext]')).toBeNull();
    p.destroy();
  });
  it('never blocks the page because a setting changed while nobody is adding notes', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    click(document.querySelector('[data-reticle-settings-btn]'));
    click(document.querySelector('[data-reticle-settings-cycle="outputDetail"]'));
    expect(overlay?.getAttribute('data-reticle-block'), 'the app stays clickable').toBe('0');
    // ...and it still blocks while notes ARE being added, which is what the setting is for.
    click(document.querySelector('[data-reticle-chat-view-btn="annotations"]'));
    click(document.querySelector('[data-reticle-annotate-btn]'));
    click(document.querySelector('[data-reticle-settings-btn]'));
    click(document.querySelector('[data-reticle-settings-cycle="outputDetail"]'));
    expect(overlay?.getAttribute('data-reticle-block')).toBe('1');
    p.destroy();
  });
  it('opens from the bubble on the first click after the toolbar was dragged', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const toolbar = document.querySelector('.reticle-toolbar-drag');
    const pointer = (type: string, x: number): void => {
      toolbar?.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: 300,
          pointerId: 7,
          button: 0,
        }),
      );
    };
    pointer('pointerdown', 400);
    pointer('pointermove', 200);
    pointer('pointerup', 200);
    click(document.querySelector('[data-reticle-min-btn]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    expect(overlay?.getAttribute('data-reticle-min')).toBe('1');
    click(document.querySelector('[data-reticle-fab]'));
    expect(overlay?.getAttribute('data-reticle-min'), 'one click opens it').toBe('0');
    p.destroy();
  });
  it('keeps the Notes page open when the first note is added', () => {
    document.body.innerHTML = '<h2 id="target">Pricing</h2>';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    const annotator = new Annotator({ emit: () => {}, now: () => 0 });
    annotator.mount();
    p.bindAnnotator(annotator);
    click(document.querySelector('[data-reticle-fab]'));
    click(document.querySelector('[data-reticle-chat-view-btn="annotations"]'));
    click(document.querySelector('[data-reticle-annotate-btn]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    document
      .getElementById('target')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 100, clientY: 120 }),
      );
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-reticle-mark="pop"] textarea',
    );
    if (null === textarea) throw new Error('note composer did not open');
    textarea.value = 'Price is wrong';
    textarea.dispatchEvent(new Event('input'));
    click(document.querySelector('[data-reticle-mark="pop"] button[data-send]'));
    expect(overlay?.getAttribute('data-reticle-page-open'), 'still on Notes').toBe('annotations');
    expect(document.querySelectorAll('.reticle-annotation-item')).toHaveLength(1);
    p.destroy();
    annotator.destroy();
  });
  it('treats every toolbar tab as a tab: clicking the open one keeps it open', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    const open = (): string => {
      if ('1' === overlay?.getAttribute('data-reticle-chat')) return 'log';
      if ('1' === overlay?.getAttribute('data-reticle-settings')) return 'settings';
      if ('1' === overlay?.getAttribute('data-reticle-report')) return 'impact';
      return overlay?.getAttribute('data-reticle-page-open') ?? 'none';
    };
    for (const [sel, name] of [
      ['[data-reticle-chat-view-btn="activity"]', 'log'],
      ['[data-reticle-chat-view-btn="flows"]', 'flows'],
      ['[data-reticle-chat-view-btn="annotations"]', 'annotations'],
      ['[data-reticle-chat-impact]', 'impact'],
      ['[data-reticle-settings-btn]', 'settings'],
    ] as const) {
      click(document.querySelector(sel));
      expect(open(), `${name} opens`).toBe(name);
      click(document.querySelector(sel));
      expect(open(), `${name} stays open when clicked again`).toBe(name);
    }
    p.destroy();
  });
  it('lights the Settings tab exactly like every other active tab', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    /*
     * The DECLARED value each property ends up with, read from every stylesheet rule that matches the
     * element, in order. jsdom does not resolve var(), so computed styles compared two unresolved
     * strings and nearly always agreed; the declarations themselves differ when the styling does.
     */
    const look = (el: Element | null): string[] => {
      if (null === el) throw new Error('toolbar button missing');
      const props = ['background', 'background-color', 'color', 'border-radius', 'width', 'height'];
      const won: Record<string, string> = {};
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          let matches = false;
          try {
            matches = el.matches(rule.selectorText);
          } catch {
            /* a selector jsdom cannot parse matches nothing here */
          }
          if (!matches) continue;
          for (const prop of props) {
            const value = rule.style.getPropertyValue(prop);
            if ('' !== value) won[prop] = value;
          }
        }
      }
      return props.map((prop) => `${prop}=${won[prop] ?? ''}`);
    };
    click(document.querySelector('[data-reticle-chat-view-btn="flows"]'));
    const flows = look(document.querySelector('[data-reticle-chat-view-btn="flows"]'));
    click(document.querySelector('[data-reticle-settings-btn]'));
    expect(document.querySelector('[data-reticle-settings-btn]')?.getAttribute('data-active')).toBe(
      '1',
    );
    expect(look(document.querySelector('[data-reticle-settings-btn]'))).toEqual(flows);
    p.destroy();
  });
  it('makes Add note the primary action and explains an empty page', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const notes = document.querySelector('[data-reticle-page-panel="annotations"]');
    expect(notes?.querySelector('[data-reticle-annotate-btn]')?.classList).toContain(
      'reticle-primary-btn',
    );
    expect(notes?.querySelector('[data-reticle-copy-all-notes]')?.getAttribute('aria-label')).toBe(
      'Copy all notes',
    );
    expect(notes?.querySelector('.reticle-annotation-empty strong')?.textContent).toBe(
      'No notes on this page',
    );
    p.destroy();
  });
  it('hands the rail Sign in to whoever can start the browser sign-in', () => {
    document.body.innerHTML = '';
    let asked = 0;
    const shell = new HudShell({ onSignIn: () => (asked += 1) });
    document.body.innerHTML = `<div data-reticle-overlay>${HudShell.dockHtml('', '', 'data-reticle-log', '', '')}</div>`;
    const root = document.querySelector<HTMLElement>('[data-reticle-overlay]');
    if (null === root) throw new Error('overlay missing');
    shell.mount(root);
    shell.paintAccount({ signedIn: false }, undefined);
    click(document.querySelector('[data-reticle-rail-signin] [data-reticle-account-signin]'));
    expect(asked).toBe(1);
    shell.teardown();
  });
  it('asks a signed-out user to sign in on every page, and shows the promo once signed in', () => {
    document.body.innerHTML = '';
    const shell = new HudShell();
    document.body.innerHTML = `<div data-reticle-overlay>${HudShell.dockHtml('', '', 'data-reticle-log', '', '')}</div>`;
    const root = document.querySelector<HTMLElement>('[data-reticle-overlay]');
    if (null === root) throw new Error('overlay missing');
    shell.mount(root);
    const signin = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-reticle-rail-signin]');
    const promo = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-reticle-rail-promo]');
    shell.paintAccount({ signedIn: false }, undefined);
    expect(signin()?.hidden).toBe(false);
    expect(signin()?.querySelector('[data-reticle-account-signin]')).not.toBeNull();
    expect(signin()?.textContent).toContain('Harness');
    // Signing in is the step: every workspace gets Harness runs. The rail says "try".
    expect(signin()?.textContent).toContain('Sign in to try Reticle Harness');
    expect(promo()?.hidden).toBe(true);
    shell.paintAccount({ signedIn: true, org: 'Acme' }, undefined);
    expect(signin()?.hidden).toBe(true);
    expect(promo()?.hidden).toBe(false);
    shell.teardown();
  });
  it('does not ship a separate flag-a-bug control', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    expect(document.querySelector('[data-reticle-flag-btn]')).toBeNull();
    expect(
      document.querySelector('.reticle-chat-nav [data-reticle-chat-view-btn="activity"]'),
    ).not.toBeNull();
    p.destroy();
  });
  it('ships inline icons on the Agent log and settings controls', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const chat = document.querySelector(
      '.reticle-chat-nav [data-reticle-chat-view-btn="activity"]',
    );
    const settings = document.querySelector('[data-reticle-settings-btn]');
    expect(chat?.querySelector('svg')).not.toBeNull();
    expect(settings?.querySelector('svg')).not.toBeNull();
    p.destroy();
  });
  it('drags from the collapsed FAB without expanding on release', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    // A session now starts EXPANDED (autoOpenChat defaults ON), so collapse to reach the FAB this
    // test is about. The behaviour under test — a drag must not be read as a click — is unchanged.
    document.querySelector<HTMLElement>('[data-reticle-min-btn]')?.click();
    const fab = document.querySelector('[data-reticle-fab]');
    const dock = document.querySelector('[data-reticle-dock]');
    expect(fab).not.toBeNull();
    expect(dock).not.toBeNull();
    fab?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 100,
        clientY: 100,
        pointerId: 9,
        button: 0,
      }),
    );
    fab?.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 80, pointerId: 9 }),
    );
    fab?.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 200, clientY: 80, pointerId: 9 }),
    );
    const overlay = document.querySelector('div[data-reticle-overlay]');
    expect(overlay?.getAttribute('data-reticle-min')).toBe('1');
    expect(dock?.getAttribute('data-dragged')).toBe('1');
    p.destroy();
  });
});

/**
 * Annotation is a mode the user chooses, so it needs a control they can see and press.
 *
 * It used to be reachable only as a side effect of expanding the HUD: expand and you were
 * annotating, collapse and you were not. That left no way to keep the HUD open and stop annotating,
 * and nothing on screen said the mode existed — the old floating button that used to say so was
 * removed with the HUD refresh, and its job did not move anywhere.
 *
 * The toggle is the user's half only. Annotation still also needs a live session and an open HUD;
 * this asserts the half that was missing without asserting away the other two.
 */
describe('the Notes capture toggle', () => {
  it('is in the Notes page and OFF until asked for', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    click(document.querySelector('[data-reticle-chat-view-btn="annotations"]'));
    const btn = document.querySelector('[data-reticle-annotate-btn]');
    expect(btn, 'the control must exist on the Notes page').not.toBeNull();
    expect(
      btn?.getAttribute('aria-pressed'),
      'annotate captures clicks, so it is entered deliberately rather than defaulted on',
    ).toBe('false');
    p.destroy();
  });

  it('flips off and back on, and reports it to assistive tech both ways', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    click(document.querySelector('[data-reticle-chat-view-btn="annotations"]'));
    const btn = document.querySelector('[data-reticle-annotate-btn]');
    click(btn);
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(btn?.getAttribute('data-active')).toBe('1');
    expect(btn?.getAttribute('aria-label')).toBe('Stop adding notes');
    expect(btn?.textContent).toContain('Stop adding notes');
    expect(
      document
        .querySelector('[data-reticle-chat-view-btn="annotations"]')
        ?.getAttribute('data-capture'),
    ).toBe('1');
    click(document.querySelector('[data-reticle-chat-view-btn="flows"]'));
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(
      document
        .querySelector('[data-reticle-chat-view-btn="annotations"]')
        ?.getAttribute('data-capture'),
    ).toBe('1');
    click(document.querySelector('[data-reticle-chat-view-btn="annotations"]'));
    click(btn);
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
    expect(btn?.getAttribute('data-active')).toBe('0');
    expect(btn?.getAttribute('aria-label')).toBe('Add notes');
    expect(
      document
        .querySelector('[data-reticle-chat-view-btn="annotations"]')
        ?.getAttribute('data-capture'),
    ).toBe('0');
    p.destroy();
  });

  /** Pressing it must not also open the chat or collapse the HUD — it sits inside both handlers. */
  it('does not disturb the HUD it lives in', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    click(document.querySelector('[data-reticle-chat-view-btn="annotations"]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    const before = overlay?.getAttribute('data-reticle-min');
    const chatBefore = overlay?.getAttribute('data-reticle-chat');
    click(document.querySelector('[data-reticle-annotate-btn]'));
    expect(overlay?.getAttribute('data-reticle-min')).toBe(before);
    expect(overlay?.getAttribute('data-reticle-chat'), 'the chat is left as it was').toBe(
      chatBefore,
    );
    p.destroy();
  });
});

/**
 * The chat needs its own way back, or the only exit is collapsing the whole HUD.
 *
 * Now that expanding opens the chat, "close the chat but keep driving" had no control at all: the
 * toolbar toggle was the sole route and it is easy to miss above a full-height panel.
 */
describe('the chat minimise button', () => {
  it('closes the chat and leaves the toolbar expanded', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    expect(overlay?.getAttribute('data-reticle-chat')).toBe('1');
    click(document.querySelector('[data-reticle-chat-min]'));
    expect(overlay?.getAttribute('data-reticle-chat'), 'chat is minimised').toBeNull();
    expect(overlay?.getAttribute('data-reticle-min'), 'the HUD stays open').toBe('0');
    p.destroy();
  });
});

/**
 * A click on the page never dismisses the chat.
 *
 * Click-outside used to close it, and every actor got it wrong: Reticle's own clicks land on the
 * page (synthetic in-page, or a genuine OS event when it drives through CDP, which no in-page
 * marker can tell from a person's), a click in annotate mode is placing a mark, and a person
 * clicking around their app while reading the log is not asking for the log to disappear.
 */
describe('the chat panel survives clicks on the page', () => {
  it('stays open for synthetic, real and annotating clicks alike', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    const ann = new Annotator({ emit: () => {}, now: () => 0 });
    ann.mount();
    p.bindAnnotator(ann);
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    expect(overlay?.getAttribute('data-reticle-chat'), 'chat opens with the HUD').toBe('1');
    const pageBtn = document.createElement('button');
    document.body.appendChild(pageBtn);
    asSyntheticInput(() => {
      pageBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(overlay?.getAttribute('data-reticle-chat'), 'the agent acting in-page').toBe('1');
    pageBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(overlay?.getAttribute('data-reticle-chat'), 'a real click, agent or person').toBe('1');
    click(document.querySelector('[data-reticle-annotate-btn]'));
    pageBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(overlay?.getAttribute('data-reticle-chat'), 'placing a mark').toBe('1');
    ann.destroy();
    p.destroy();
  });

  it('opens the Agent log from the bottom bar and closes from the panel or Escape', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    click(document.querySelector('[data-reticle-chat-min]'));
    click(document.querySelector('.reticle-chat-nav [data-reticle-chat-view-btn="activity"]'));
    expect(overlay?.getAttribute('data-reticle-chat'), 'the Agent log opens the panel').toBe('1');
    click(document.querySelector('[data-reticle-chat-min]'));
    expect(
      overlay?.getAttribute('data-reticle-chat'),
      'the panel has its own minimise control',
    ).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay?.getAttribute('data-reticle-chat'), 'Escape is a way out').toBeNull();
    p.destroy();
  });
});

/**
 * The minimised chat is a capsule, not a hole.
 *
 * Minimising used to leave the toolbar above empty space, so a minimised session looked exactly
 * like no session at all. The capsule keeps the state dot and the last action visible, and is
 * itself the way back into the panel.
 */
describe('the minimised chat capsule', () => {
  it('appears when the chat is minimised and reopens it when clicked', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    const overlay = document.querySelector('div[data-reticle-overlay]');
    const pill = document.querySelector('[data-reticle-chat-pill]');
    expect(pill, 'the capsule is part of the dock').not.toBeNull();
    click(document.querySelector('[data-reticle-chat-min]'));
    expect(overlay?.getAttribute('data-reticle-chat'), 'chat is minimised').toBeNull();
    expect(overlay?.getAttribute('data-reticle-min'), 'the toolbar stays expanded').toBe('0');
    click(pill);
    expect(overlay?.getAttribute('data-reticle-chat'), 'the capsule reopens the chat').toBe('1');
    p.destroy();
  });

  it('carries the last action text', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    p.status('Clicking button "Deploy"');
    expect(document.querySelector('[data-reticle-chat-pill-text]')?.textContent).toContain(
      'Deploy',
    );
    p.destroy();
  });
});

/**
 * The status colour must reach everything that signals, not just the dot.
 *
 * The glow, the collapsed FAB's halo and the capsule all sit outside the activity strip, so the
 * liveness the strip knows about is mirrored onto the overlay root for them to resolve against.
 */
describe('session state is published for the colour system', () => {
  it('mirrors liveness onto the overlay root', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    const overlay = document.querySelector('div[data-reticle-overlay]');
    p.status('Clicking button "Deploy"');
    expect(overlay?.getAttribute('data-reticle-live'), 'acting reads as active').toBe('active');
    p.destroy();
  });
});

/**
 * Opening the chat shows the LATEST activity.
 *
 * The feed follows its newest row on append - but a closed panel has no layout, so rows logged
 * while it was minimised could not move it. Opening it left the feed parked at the oldest row, and
 * the thing you opened it to see was somewhere below the fold.
 */
describe('the activity feed opens at the newest row', () => {
  it('scrolls to the bottom when the chat is opened', async () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.sessionStart();
    click(document.querySelector('[data-reticle-fab]'));
    click(document.querySelector('[data-reticle-chat-min]'));
    const log = document.querySelector<HTMLElement>('[data-reticle-log]');
    if (null === log) throw new Error('no log');
    for (let i = 0; i < 12; i += 1) p.log(LOG_KIND.ACT, `row ${String(i)}`);
    // jsdom has no layout: model a feed taller than its box, and a scroll position stuck at the top.
    Object.defineProperty(log, 'scrollHeight', { value: 900, configurable: true });
    log.scrollTop = 0;
    click(document.querySelector('[data-reticle-chat-toggle]'));
    expect(log.scrollTop, 'the newest row is the one you came to see').toBe(900);
    // and it keeps landing there while the rows render their real heights
    Object.defineProperty(log, 'scrollHeight', { value: 1400, configurable: true });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    expect(log.scrollTop, 'a feed that grew after layout still ends at the bottom').toBe(1400);
    p.destroy();
  });
});

/**
 * Teardown has to actually remove what mount added.
 *
 * Every click handler in the shell is an anonymous closure over `this`, so there was no reference
 * to hand `removeEventListener` and none of them was ever removed.
 *
 * Asserting the MECHANISM rather than a side effect, deliberately. The obvious test — destroy, then
 * dispatch, then check nothing happened — passes whether or not the listeners were removed, because
 * `destroy()` also removes the HUD from the DOM, so the handlers are unreachable either way. I wrote
 * that version first and it stayed green with the `abort()` deleted, which is the vacuous-guard
 * shape #455 is about. Recording every registration and checking its signal is aborted is the thing
 * that actually goes red.
 */
describe('presenter HUD shell teardown', () => {
  interface Registration {
    type: string;
    signal: AbortSignal | undefined;
  }

  /** Record every document-level registration and the signal (if any) it was given. */
  const recordDocumentListeners = (): { seen: Registration[]; restore: () => void } => {
    const seen: Registration[] = [];
    const real = document.addEventListener.bind(document);
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      const signal = 'object' === typeof options && null !== options ? options.signal : undefined;
      seen.push({ type, signal });
      real(type, listener, options);
    }) as typeof document.addEventListener;
    return { seen, restore: () => (document.addEventListener = real) };
  };

  it('registers its document listeners with a signal, and aborts it on teardown', () => {
    // HudShell directly, not through Presenter: the settings, report and drag components register
    // pointerdown/keydown on `document` too, and this change is scoped to one file. Driving the
    // shell alone means the assertion is about the listeners this PR converted and nothing else.
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.querySelector<HTMLElement>('#root');
    if (null === root) throw new Error('no root');

    const { seen, restore } = recordDocumentListeners();
    const shell = new HudShell({});
    shell.mount(root);
    restore();

    // Guards the guard: if the shell stops registering these, the loop below passes for free.
    // FOUR, not two: the shell's own pointerdown/keydown, plus the account menu's, which close it on
    // an outside click and on Escape. Both pairs must be aborted by the same teardown, which is what
    // the loops below are for.
    expect(seen.length, 'the shell should install its document listeners').toBe(4);
    expect(seen.map((r) => r.type).sort()).toEqual([
      'keydown',
      'keydown',
      'pointerdown',
      'pointerdown',
    ]);
    for (const registration of seen) {
      expect(
        registration.signal,
        `${registration.type} was registered with no signal`,
      ).toBeDefined();
      expect(registration.signal?.aborted, `${registration.type} aborted before teardown`).toBe(
        false,
      );
    }

    shell.teardown();

    for (const registration of seen) {
      expect(
        registration.signal?.aborted,
        `${registration.type} outlived teardown() — its signal was never aborted`,
      ).toBe(true);
    }
  });

  it('disconnects the toolbar MutationObserver on teardown', () => {
    // A MutationObserver takes no signal, so it is not covered by the abort — and this disconnect
    // was missing entirely, leaving the observer holding `root` after teardown.
    document.body.innerHTML = '';
    const disconnected: string[] = [];
    const RealObserver = globalThis.MutationObserver;
    class SpyObserver extends RealObserver {
      override disconnect(): void {
        disconnected.push('disconnect');
        super.disconnect();
      }
    }
    globalThis.MutationObserver = SpyObserver;
    try {
      document.body.innerHTML = '<div id="root"></div>';
      const root = document.querySelector<HTMLElement>('#root');
      if (null === root) throw new Error('no root');
      const shell = new HudShell({});
      shell.mount(root);
      const before = disconnected.length;
      shell.teardown();
      expect(disconnected.length, 'teardown() disconnected no MutationObserver').toBeGreaterThan(
        before,
      );
    } finally {
      globalThis.MutationObserver = RealObserver;
    }
  });
});
