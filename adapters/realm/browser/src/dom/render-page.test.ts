import { afterEach, describe, expect, it } from 'vitest';
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
});
