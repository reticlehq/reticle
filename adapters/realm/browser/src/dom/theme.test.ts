import { describe, it, expect, beforeEach } from 'vitest';
import { themeReport, tokenNames } from './theme.js';

/** Declare a palette + render an element, then report its theme compliance from computed style. */
function setup(paletteCss: string, html: string): CSSStyleDeclaration {
  document.head.innerHTML = `<style>${paletteCss}</style>`;
  document.body.innerHTML = html;
  const el = document.body.firstElementChild as HTMLElement;
  return getComputedStyle(el);
}

describe('themeReport — design-token compliance', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
  });

  it('a color that matches a design token is on-theme (offTheme false, token named)', () => {
    const cs = setup(
      ':root{--accent:rgb(10,20,30);}',
      '<button style="color:rgb(10,20,30)">ok</button>',
    );
    const r = themeReport(cs);
    expect(r.tokenCount).toBeGreaterThan(0);
    expect(r.colorTokens).toEqual(['--accent']);
    expect(r.colorToken).toBe('--accent');
    expect(r.offTheme).toBe(false);
  });

  it('an off-palette color is flagged offTheme with no matching token', () => {
    const cs = setup(
      ':root{--accent:rgb(10,20,30);}',
      '<button style="color:rgb(255,0,255)">bug</button>',
    );
    const r = themeReport(cs);
    expect(r.colorTokens).toEqual([]);
    expect(r.colorToken).toBeNull();
    expect(r.offTheme).toBe(true);
  });

  it('a transparent color is never flagged (no visual weight)', () => {
    const cs = setup(
      ':root{--accent:rgb(10,20,30);}',
      '<button style="color:rgb(10,20,30);background:transparent">x</button>',
    );
    const r = themeReport(cs);
    expect(r.backgroundTokens).toEqual([]);
    expect(r.offTheme).toBe(false); // bg transparent → ignored; color matches token
  });

  it('with no palette declared, offTheme is never asserted (cannot violate a missing theme)', () => {
    const cs = setup('', '<button style="color:rgb(255,0,255)">x</button>');
    const r = themeReport(cs);
    expect(r.tokenCount).toBe(0);
    expect(r.offTheme).toBe(false);
  });

  it('every token sharing the color is returned, and the singular field abstains on a tie', () => {
    const cs = setup(
      ':root{--brand-primary:rgb(10,20,30);--border-focus:rgb(10,20,30);}',
      '<button style="color:rgb(10,20,30);background:rgb(10,20,30)">brand</button>',
    );
    const r = themeReport(cs);
    expect(r.backgroundTokens).toEqual(['--border-focus', '--brand-primary']);
    expect(r.backgroundToken).toBeNull();
    expect(r.offTheme).toBe(false);
  });

  it('a theme toggle between two lookups is read under the theme now active', () => {
    const cs = setup(
      ':root{--text-primary:rgb(1,2,3);} .dark{--text-primary:rgb(9,9,9);}',
      '<summary style="color:rgb(9,9,9)">x</summary>',
    );
    const before = themeReport(cs);
    expect(before.colorTokens).toEqual([]);
    expect(before.offTheme).toBe(true);
    expect(before.themeScope).toBeNull();

    document.documentElement.className = 'dark';
    const after = themeReport(cs);
    expect(after.colorTokens).toEqual(['--text-primary']);
    expect(after.offTheme).toBe(false);
    expect(after.themeScope).toBe('.dark');
  });

  it('the theme scope names the data-theme attribute as well as the class', () => {
    const cs = setup(
      ':root{--accent:rgb(10,20,30);}',
      '<button style="color:rgb(10,20,30)">x</button>',
    );
    document.documentElement.className = 'dark compact';
    document.documentElement.setAttribute('data-theme', 'midnight');
    expect(themeReport(cs).themeScope).toBe('.dark.compact[data-theme="midnight"]');
  });

  it('tokens declared only under a theme selector count once that theme is active', () => {
    const cs = setup(
      '[data-theme="dark"]{--surface:rgb(4,5,6);}',
      '<div style="background:rgb(4,5,6)">x</div>',
    );
    expect(themeReport(cs).tokenCount).toBe(0); // scope inactive: nothing resolves
    document.documentElement.setAttribute('data-theme', 'dark');
    const r = themeReport(cs);
    expect(r.backgroundTokens).toEqual(['--surface']);
    expect(r.tokenCount).toBe(1);
  });
});

describe('tokenNames — discovery inside grouping rules', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  /** Tailwind v4 keeps its theme tokens in `@layer theme { :root { … } }`. */
  it('finds a token declared inside @layer', () => {
    document.head.innerHTML = '<style>@layer theme { :root { --brand: #123456; } }</style>';
    expect(tokenNames()).toContain('--brand');
  });

  it('finds a token declared inside @media', () => {
    document.head.innerHTML =
      '<style>@media (min-width: 1px) { :root { --mq-token: #111111; } }</style>';
    expect(tokenNames()).toContain('--mq-token');
  });

  it('finds a token nested inside several grouping rules', () => {
    document.head.innerHTML =
      '<style>@layer theme { @media (min-width: 1px) { @supports (display: grid) { :root { --nested-token: #222222; } } } }</style>';
    expect(tokenNames()).toContain('--nested-token');
  });

  it('does not recurse past the depth bound', () => {
    const deep =
      '@media (min-width: 1px) { '.repeat(12) +
      ':root { --deep-token: #333333; }' +
      ' }'.repeat(12);
    document.head.innerHTML = `<style>${deep}</style>`;
    expect(tokenNames()).not.toContain('--deep-token');
  });
});
