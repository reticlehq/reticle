/**
 * The manual Vite snippet and the codemod agree, and neither claims something the plugin contradicts.
 *
 * THE DEFECT THIS EXISTS FOR: `viteManual` told the reader "Keep `reticle()` LAST so it sees the
 * output of your other plugins", and showed `[react(), reticle()]`. Both halves were wrong. The
 * plugin declares `enforce: 'pre'` (adapters/build/vite/src/index.ts), so Vite runs it before every
 * normal plugin whatever its position in the array — the position does not matter, and the stated
 * reason is backwards, because `pre` means it sees the source BEFORE the other plugins, not their
 * output. Meanwhile `insertPlugin` in vite-config.ts writes `reticle()` FIRST, and docs/frameworks
 * shows it first too, so the one path a reader takes by hand disagreed with every other path.
 *
 * Found on 2026-09-22 while checking that documented snippets match what the product does. This is
 * the manual path, reached when the config cannot be auto-patched — the readers least able to spot
 * the difference and most likely to end up uninstrumented.
 */
import { describe, expect, it } from 'vitest';
import { patchViteConfig } from './vite-config.js';
import { viteManual } from './snippets.js';
import { UiLibrary } from '@/detect/detect.js';

describe('the Vite snippet a reader copies by hand', () => {
  const snippet = viteManual(undefined, UiLibrary.REACT);

  it('does not tell anyone the position matters', () => {
    expect(snippet).not.toMatch(/LAST/);
  });

  it('says why the position does not matter, rather than leaving it unexplained', () => {
    expect(snippet).toMatch(/enforce/i);
  });

  it('shows the same order the codemod writes, so the two paths cannot be compared and doubted', () => {
    const patched = patchViteConfig(
      "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n",
      undefined,
    );
    const written = 'code' in patched ? patched.code : '';
    // The codemod inserts right after the opening bracket.
    expect(written).toContain('plugins: [reticle(), react()]');
    expect(snippet).toContain('plugins: [reticle(), react()]');
  });
});
