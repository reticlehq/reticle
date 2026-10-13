/**
 * Text-first value cards; the daemon's notices replace them.
 */
import { describe, expect, it } from 'vitest';
import { panelSlides } from './panel-slides.js';

describe('panelSlides', () => {
  it('shows the product value cards when the daemon sent no notices', () => {
    expect(panelSlides().map((s) => s.id)).toEqual(['replay-confidence', 'notes-for-agent']);
  });

  /*
   * The rail sits right under the Agent Log's Harness block, so a Harness card there said the same
   * thing twice, and its detail was cut off mid-word at the HUD's width.
   */
  it('does not advertise Harness under the panel that already offers it', () => {
    const text = panelSlides()
      .map((s) => s.html)
      .join('');
    expect(text).not.toContain('Harness');
  });

  it('keeps every value card short enough to fit one line of the rail', () => {
    for (const slide of panelSlides()) {
      const host = document.createElement('div');
      host.innerHTML = slide.html;
      const title = host.querySelector('.reticle-promo-title')?.textContent ?? '';
      const detail = host.querySelector('.reticle-promo-detail')?.textContent ?? '';
      expect(title.length, title).toBeLessThanOrEqual(32);
      expect(detail.length, detail).toBeLessThanOrEqual(36);
    }
  });
});

/** The rail edited without a release: the daemon's notices replace the bundled value slides. */
describe('remote notices', () => {
  it('renders the notices the daemon chose, escaped, in place of the bundled slides', () => {
    const slides = panelSlides([
      {
        id: 'personas',
        kicker: 'NEW',
        title: 'Five personas <b>at once</b>',
        detail: 'Drives every journey',
        cta: { label: 'See how', url: 'https://reticle.sh/harness?a=1&b=2' },
      },
    ]);
    expect(slides.map((s) => s.id)).toEqual(['notice-personas']);
    const host = document.createElement('div');
    host.innerHTML = slides[0]?.html ?? '';
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('Five personas <b>at once</b>');
    expect(host.querySelector('a')?.getAttribute('href')).toBe(
      'https://reticle.sh/harness?a=1&b=2',
    );
  });

  it('drops a notice that fails the schema, such as a link off our sites', () => {
    const slides = panelSlides([
      { id: 'ok', title: 'Fine' },
      { id: 'phish', title: 'Bad', cta: { label: 'Go', url: 'https://evil.example/x' } },
      'not a notice',
    ]);
    expect(slides.map((s) => s.id)).toEqual(['notice-ok']);
  });

  /*
   * The hosted notices file carried a Harness card, and the rail showed it right under the Agent
   * Log's own Harness block, cut off mid-sentence. The panel already offers Harness; the rail does not.
   */
  it('drops a Harness notice, since the panel above already offers Harness', () => {
    const slides = panelSlides([
      { id: 'harness-drive', title: 'Let Reticle drive your app for you' },
      { id: 'replayable-journeys', title: 'Keep every journey replayable' },
    ]);
    expect(slides.map((s) => s.id)).toEqual(['notice-replayable-journeys']);
  });

  it('falls back to the bundled cards when every notice was a Harness one', () => {
    const slides = panelSlides([{ id: 'harness-drive', title: 'Drive' }]);
    expect(slides.map((s) => s.id)).toEqual(panelSlides().map((s) => s.id));
  });

  it('keeps the whole sentence one hover away when a notice is too long for the rail', () => {
    const [slide] = panelSlides([
      {
        id: 'long',
        title: 'A title',
        detail: 'A detail far too long to fit on one line of the rail',
      },
    ]);
    const host = document.createElement('div');
    host.innerHTML = slide?.html ?? '';
    expect(host.querySelector('.reticle-promo-detail')?.getAttribute('title')).toBe(
      'A detail far too long to fit on one line of the rail',
    );
  });

  it('keeps the bundled slides when the daemon sent none', () => {
    expect(panelSlides([]).map((s) => s.id)).toEqual(panelSlides().map((s) => s.id));
  });
});

/** A self-hosted or local platform: its value cards linked to the hosted one. */
describe('the value cards on a platform that is not the hosted one', () => {
  it('link to the platform the daemon uses', () => {
    const html = panelSlides([], 'http://localhost:18340')
      .map((slide) => slide.html)
      .join('');
    expect(html).toContain('href="http://localhost:18340/settings?group=billing"');
    expect(html).not.toContain('app.reticle.sh');
  });
});
