import { afterEach, describe, expect, it, vi } from 'vitest';
import { RETICLE_OVERLAY_SELECTOR } from '@reticlehq/core';
import { cloneForRender, MASK } from './render-page.js';

/**
 * The rendered step screenshot leaves the machine with its run, so what the page DRAWS is what the
 * platform stores. A typed password, or a token sitting in a text box, must never reach the image.
 */
describe('cloneForRender', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Reflect.deleteProperty(document, 'getAnimations');
    Reflect.deleteProperty(window, 'scrollX');
    Reflect.deleteProperty(window, 'scrollY');
    vi.restoreAllMocks();
  });

  it('masks a password and a secret-named field, and keeps what the user typed elsewhere', () => {
    document.body.innerHTML =
      '<input id="pw" type="password"><input id="tok" name="token"><input id="email">' +
      '<textarea id="note"></textarea><input id="ok" type="checkbox">';
    (document.getElementById('pw') as HTMLInputElement).value = 'hunter2';
    (document.getElementById('tok') as HTMLInputElement).value = 'sk-live-123';
    (document.getElementById('email') as HTMLInputElement).value = 'a@b.co';
    (document.getElementById('note') as HTMLTextAreaElement).value = 'hello';
    (document.getElementById('ok') as HTMLInputElement).checked = true;

    const html = new XMLSerializer().serializeToString(cloneForRender(document));

    expect(html).not.toContain('hunter2');
    expect(html).not.toContain('sk-live-123');
    expect(html).toContain(MASK);
    expect(html).toContain('a@b.co');
    expect(html).toContain('hello');
    expect(html).toMatch(/id="ok"[^>]*checked/);
  });

  it("leaves out Reticle's own UI and every script", () => {
    document.body.innerHTML =
      '<p>app</p><script>var x = 1;</script><div data-reticle-hud>RETICLE-HUD</div>';
    expect(document.querySelector(RETICLE_OVERLAY_SELECTOR)).not.toBeNull();

    const html = new XMLSerializer().serializeToString(cloneForRender(document));

    expect(html).toContain('app');
    expect(html).not.toContain('RETICLE-HUD');
    expect(html).not.toContain('var x');
  });

  it('draws an animated row at the frame the page shows now, not at the first keyframe', () => {
    // An SVG image starts every animation again at its first frame. A row that fades in from
    // opacity 0 was drawn blank, so the screenshot left out content that the user could see.
    document.body.innerHTML = '<ul><li id="row" style="animation: fade 1s">row text</li></ul>';
    const row = document.getElementById('row') as HTMLElement;
    const effect = {
      target: row,
      getKeyframes: () => [
        { opacity: '0', offset: 0 },
        { opacity: '1', offset: 1 },
      ],
    };
    Object.assign(document, { getAnimations: () => [{ effect }] });
    row.style.opacity = '0.9';

    const twin = cloneForRender(document).querySelector('#row') as HTMLElement;

    expect(twin.style.animation).toBe('none');
    expect(twin.style.opacity).toBe('0.9');
  });

  it('moves the frame to the viewport without a transform, so a fixed overlay fills the viewport', () => {
    // #2433: a transform on the root makes the root the box that a fixed element fills. A
    // full-screen overlay was drawn only as tall as the content: a thin band across the top.
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 550, configurable: true });
    document.body.innerHTML = '<p>page</p>';

    const clone = cloneForRender(document);

    expect(clone.style.transform).toBe('');
    expect(clone.style.position).toBe('relative');
    expect(clone.style.top).toBe('-550px');
    expect(clone.style.left).toBe('0px');
  });

  it('draws a modal dialog above everything, with its backdrop, and not where it sits in the tree', () => {
    // #2433: the clone keeps `open` but not the top layer. The dialog was drawn inside its parent,
    // under an overlay that stacked above that parent, so the screenshot left it out.
    document.body.innerHTML =
      '<div id="wrap" style="position:relative;z-index:1"><p>page</p>' +
      '<dialog id="d" open><h2 id="title" style="color:rgb(1, 2, 3)">Dialog title</h2>' +
      '<script>var y = 1;</script></dialog></div>' +
      '<div style="position:fixed;inset:0;z-index:50"></div>';
    const dialog = document.getElementById('d') as HTMLDialogElement;
    // jsdom has no showModal() and no top layer; a real browser matches `:modal` here.
    vi.spyOn(dialog, 'matches').mockImplementation((selector) => ':modal' === selector);

    const clone = cloneForRender(document);

    const twin = clone.querySelector('#d') as HTMLElement;
    expect(clone.querySelector('#wrap #d')).toBeNull();
    const host = twin.parentElement as HTMLElement;
    expect(host.parentElement).toBe(clone.querySelector('body'));
    expect(host).toBe(clone.querySelector('body')?.lastElementChild);
    expect(host.style.position).toBe('fixed');
    expect(host.style.zIndex).toBe('2147483647');
    expect(twin.style.position).toBe('fixed');
    expect(twin.style.zIndex).toBe('2147483647');
    // Styled as the page shows it now, since the selectors that styled it in place do not reach it.
    expect((twin.querySelector('#title') as HTMLElement).style.color).toBe('rgb(1, 2, 3)');
    expect(new XMLSerializer().serializeToString(clone)).not.toContain('var y');
  });

  it('leaves a dialog that is not in the top layer where it is', () => {
    document.body.innerHTML = '<div id="wrap"><dialog id="d" open>inline</dialog></div>';

    const clone = cloneForRender(document);

    expect(clone.querySelector('#wrap #d')).not.toBeNull();
    expect((clone.querySelector('#d') as HTMLElement).style.position).toBe('');
  });
});
