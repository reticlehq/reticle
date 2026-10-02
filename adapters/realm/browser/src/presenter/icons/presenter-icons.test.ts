import { describe, it, expect } from 'vitest';
import { PresenterIcon, hiIconHtml, hiToggleIconHtml } from './presenter-icons.js';
import { HERO_ICON_BODIES, HERO_ICON_SOLID_BODIES } from './presenter-heroicons-data.js';

describe('presenter heroicons', () => {
  it('every PresenterIcon key has an embedded SVG body', () => {
    for (const key of Object.values(PresenterIcon)) {
      expect(key in HERO_ICON_BODIES, `missing body for ${key}`).toBe(true);
    }
  });

  it('hiIconHtml inlines an svg for toolbar keys', () => {
    const html = hiIconHtml(PresenterIcon.MESSAGE, 18);
    expect(html).toContain('<svg');
    expect(html).toContain('reticle-hi-icon');
    expect(html).toContain('width="18"');
    expect(html).toContain('viewBox="0 0 24 24"');
  });

  it('hiToggleIconHtml pairs outline and solid layers for active toggles', () => {
    const html = hiToggleIconHtml(PresenterIcon.MESSAGE, 18);
    expect(html).toContain('reticle-hi-toggle');
    expect(html).toContain('reticle-hi-icon--outline');
    expect(html).toContain('reticle-hi-icon--solid');
    expect(HERO_ICON_BODIES.message.length).toBeGreaterThan(0);
    expect(HERO_ICON_SOLID_BODIES.message.length).toBeGreaterThan(0);
  });
});
