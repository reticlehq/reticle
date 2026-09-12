import { describe, expect, it } from 'vitest';
import { htmlManual } from './snippets.js';

/**
 * A snippet we tell people to paste has to COMPILE in the project we are telling them to paste it
 * into. This one did not, in the exact stack it names first.
 *
 * Reported from a real install: "The CRA snippet init prints does not compile. location.hostname →
 * no-restricted-globals is an error in CRA's default eslint. Every CRA user gets a failed build from
 * copy-paste."
 *
 * There was a second failure in the same four lines that the report had not reached yet: the snippet
 * used top-level `await import(...)`. CRA is webpack 5, where top-level await sits behind
 * `experiments.topLevelAwait` and is off by default — so fixing only the global would have handed
 * the next user a parse error instead of a lint error.
 *
 * Neither is catchable by any gate in this repo: the snippet is a string, so it is never parsed,
 * linted or built here. It is only ever compiled on a stranger's machine. That is what makes a
 * hand-checked guard worth having at all.
 */
describe('the pasteable CRA/webpack snippet compiles where it is pasted', () => {
  const snippet = htmlManual(4400, 'demo');

  it('never reaches for the bare global CRA forbids', () => {
    // The guard this originally policed (`window.location.hostname === 'localhost'`) is gone: it is
    // false on any non-localhost dev host and undefined during SSR, and it cost a reporter their
    // whole setup silently. See html-no-build.test.ts. The lint hazard it left behind is still worth
    // pinning, because the obvious way to reintroduce a host check is the one CRA rejects.
    expect(snippet).not.toMatch(/(?<!window\.)\blocation\.hostname\b/);
  });

  it('does not rely on top-level await, which CRA does not enable', () => {
    expect(snippet).not.toMatch(/\bawait\s+import\(/);
  });

  it('still actually connects — the point of the snippet survives the fix', () => {
    expect(snippet).toContain("import('@reticlehq/react')");
    expect(snippet).toContain('reticle.connect(');
    expect(snippet).toContain('install()');
  });
});
