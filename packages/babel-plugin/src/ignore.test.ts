import { describe, expect, it } from 'vitest';
import { isSourceStampingIgnored } from './ignore.js';

/**
 * A per-file opt-out for source stamping (#853, part 1).
 *
 * The only lever before this was the plugin's include/exclude globs, which live in the bundler
 * config — far from the file, and awkward when the reason to skip is local ("this component is
 * generated", "stamping this one breaks a snapshot test"). A comment sits with the code and
 * survives the refactor that moves the file.
 *
 * FIRST non-empty line, whole file. Not "anywhere in the file": a marker that works from line 40
 * is a marker nobody can find, and not per-declaration: that is a different feature with a
 * different question.
 */
describe('isSourceStampingIgnored', () => {
  it('recognises the line comment as the first non-empty line', () => {
    expect(isSourceStampingIgnored('// @reticle-ignore\nconst x = 1;')).toBe(true);
  });

  it('tolerates leading blank lines and indentation — "first non-empty" means what it says', () => {
    expect(isSourceStampingIgnored('\n\n   // @reticle-ignore\nconst x = 1;')).toBe(true);
  });

  it('recognises the block form, for files whose first line convention is a block comment', () => {
    expect(isSourceStampingIgnored('/* @reticle-ignore */\nconst x = 1;')).toBe(true);
  });

  it('recognises the HTML form, because a .svelte file has no line for a // before its markup', () => {
    expect(isSourceStampingIgnored('<!-- @reticle-ignore -->\n<div>hi</div>')).toBe(true);
  });

  it('is strict about the position — a marker after the first non-empty line does nothing', () => {
    // A license header on line 1 and the marker on line 2 is the case this decides. Documented as
    // "first non-empty line" rather than "near the top", so the rule can be checked at a glance.
    expect(isSourceStampingIgnored("import React from 'react';\n// @reticle-ignore\n")).toBe(false);
    expect(isSourceStampingIgnored('/* license */\n// @reticle-ignore\n')).toBe(false);
  });

  it('is strict about the word — a prefix or a different marker is not this one', () => {
    expect(isSourceStampingIgnored('// @reticle-ignored\n')).toBe(false);
    expect(isSourceStampingIgnored('// reticle-ignore\n')).toBe(false);
    expect(isSourceStampingIgnored('// @reticle-ignore-next-line\n')).toBe(false);
  });

  it('is off on an ordinary file', () => {
    expect(isSourceStampingIgnored('const x = <button>Hi</button>;')).toBe(false);
    expect(isSourceStampingIgnored('')).toBe(false);
  });
});
