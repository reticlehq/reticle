import { describe, it, expect, beforeEach } from 'vitest';
import { themeReport, resetThemeCache } from './theme.js';

/** Declare a palette + render an element, then report its theme compliance from computed style. */
function setup(paletteCss: string, html: string): CSSStyleDeclaration {
  document.head.innerHTML = `<style>${paletteCss}</style>`;
  document.body.innerHTML = html;
  resetThemeCache();
  const el = document.body.firstElementChild as HTMLElement;
  return getComputedStyle(el);
}

describe('themeReport — design-token compliance', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    resetThemeCache();
  });

  it('a color that matches a design token is on-theme (offTheme false, token named)', () => {
    const cs = setup(
      ':root{--accent:rgb(10,20,30);}',
      '<button style="color:rgb(10,20,30)">ok</button>',
    );
    const r = themeReport(cs);
    expect(r.tokenCount).toBeGreaterThan(0);
    expect(r.colorToken).toBe('--accent');
    expect(r.offTheme).toBe(false);
  });

  it('an off-palette color is flagged offTheme with no matching token', () => {
    const cs = setup(
      ':root{--accent:rgb(10,20,30);}',
      '<button style="color:rgb(255,0,255)">bug</button>',
    );
    const r = themeReport(cs);
    expect(r.colorToken).toBeNull();
    expect(r.offTheme).toBe(true);
  });

  it('a transparent color is never flagged (no visual weight)', () => {
    const cs = setup(
      ':root{--accent:rgb(10,20,30);}',
      '<button style="color:rgb(10,20,30);background:transparent">x</button>',
    );
    const r = themeReport(cs);
    expect(r.backgroundToken).toBeNull();
    expect(r.offTheme).toBe(false); // bg transparent → ignored; color matches token
  });

  it('with no palette declared, offTheme is never asserted (cannot violate a missing theme)', () => {
    const cs = setup('', '<button style="color:rgb(255,0,255)">x</button>');
    const r = themeReport(cs);
    expect(r.tokenCount).toBe(0);
    expect(r.offTheme).toBe(false);
  });
});
