/**
 * Text-first Harness value cards are always useful; the offer only appears when eligible.
 */
import { describe, expect, it } from 'vitest';
import { panelSlides } from './panel-slides.js';

const CLAIM_URL = 'https://app.reticle.sh/harness';

describe('panelSlides', () => {
  it('leads with the offer when it applies, followed by product value cards', () => {
    const ids = panelSlides({ claimed: false, claimUrl: CLAIM_URL }, false).map((s) => s.id);
    expect(ids).toEqual(['harness-offer', 'replay-confidence', 'notes-for-agent']);
  });

  it('shows the value cards when no offer is known', () => {
    expect(panelSlides(undefined, false).map((s) => s.id)).toEqual([
      'replay-confidence',
      'notes-for-agent',
    ]);
  });

  it('keeps the product value cards when somebody already declined the offer', () => {
    expect(panelSlides({ claimed: false, claimUrl: CLAIM_URL }, true).map((s) => s.id)).toEqual([
      'replay-confidence',
      'notes-for-agent',
    ]);
  });

  /*
   * The rail sits right under the Agent Log's Harness block, so a Harness card there said the same
   * thing twice, and its detail was cut off mid-word at the HUD's width.
   */
  it('does not advertise Harness under the panel that already offers it', () => {
    const text = panelSlides(undefined, false)
      .map((s) => s.html)
      .join('');
    expect(text).not.toContain('Harness');
  });

  it('keeps every value card short enough to fit one line of the rail', () => {
    for (const slide of panelSlides(undefined, false)) {
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
    const slides = panelSlides(undefined, false, [
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
    const slides = panelSlides(undefined, false, [
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
    const slides = panelSlides(undefined, false, [
      { id: 'harness-drive', title: 'Let Reticle drive your app for you' },
      { id: 'replayable-journeys', title: 'Keep every journey replayable' },
    ]);
    expect(slides.map((s) => s.id)).toEqual(['notice-replayable-journeys']);
  });

  it('falls back to the bundled cards when every notice was a Harness one', () => {
    const slides = panelSlides(undefined, false, [{ id: 'harness-drive', title: 'Drive' }]);
    expect(slides.map((s) => s.id)).toEqual(panelSlides(undefined, false).map((s) => s.id));
  });

  it('keeps the whole sentence one hover away when a notice is too long for the rail', () => {
    const [slide] = panelSlides(undefined, false, [
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
    expect(panelSlides(undefined, false, []).map((s) => s.id)).toEqual(
      panelSlides(undefined, false).map((s) => s.id),
    );
  });
});

/** A self-hosted or local platform: its value cards linked to the hosted one. */
describe('the value cards on a platform that is not the hosted one', () => {
  it('link to the platform the daemon uses', () => {
    const html = panelSlides(undefined, false, [], 'http://localhost:18340')
      .map((slide) => slide.html)
      .join('');
    expect(html).toContain('href="http://localhost:18340/settings?group=billing"');
    expect(html).not.toContain('app.reticle.sh');
  });
});
