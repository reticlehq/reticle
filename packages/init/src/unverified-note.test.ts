import { describe, expect, it } from 'vitest';
import { astroManual, unverifiedUiLibraryNote } from './snippets.js';

/**
 * An UNVERIFIED notice has to be accurate about what is actually lost, or it does damage in the
 * other direction.
 *
 * Reported from the field: "The UNVERIFIED notices are wrong about what's lost. preact and svelte
 * both got real file:line (lang-selector.jsx:59, +page.svelte:69). Only componentStack was empty.
 * The notice says file:line 'will be missing' — that undersells it and makes users skip the stacks."
 *
 * Overstating a limitation is not the safe direction. It reads as caution and costs the user the
 * single most valuable thing Reticle produces — the pointer from a finding to the file to open.
 */
describe('the unverified-library notice describes the real gap', () => {
  const note = unverifiedUiLibraryNote('svelte');

  it('does not claim source file:line is missing — it is not', () => {
    expect(note).not.toMatch(/file:line will be missing/i);
    expect(note).toMatch(/file:line/);
  });

  it('names what IS missing: React component identity', () => {
    expect(note).toMatch(/component names/i);
    expect(note).toMatch(/component stacks?/i);
  });

  it('still says the stack is ungated, which is the actual warning', () => {
    expect(note).toMatch(/no CI gate covers svelte/i);
  });
});

/**
 * Instructions must name a file the project actually has.
 *
 * Reported from the field: on `examples/framework-react` — no layout at all, only
 * `src/pages/index.astro` — init printed thirty lines telling the user to paste the connect "in
 * your layout". Naming a file that is not there reads as a mistake by the reader, and costs them the
 * time it takes to go and confirm it is missing.
 */
describe('the Astro recipe names a file that exists', () => {
  it('points at the real layout when there is one', () => {
    const note = astroManual(4400, 'demo', 'src/layouts/Base.astro');
    expect(note).toContain('src/layouts/Base.astro');
    expect(note).not.toMatch(/In your layout/i);
  });

  it('says there is no layout, and points at a page, when there is not', () => {
    const note = astroManual(4400, 'demo', undefined);
    expect(note).toMatch(/no layout/i);
    expect(note).toContain('src/pages/index.astro');
    expect(note).not.toMatch(/In your layout/i);
  });

  it('still explains that every page needs it — a page-level connect is per-page', () => {
    expect(astroManual(4400, 'demo', undefined)).toMatch(/every page/i);
  });
});
