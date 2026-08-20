import { describe, expect, it } from 'vitest';
import { openFailureNote } from './open-note.js';

describe('reticle open, when it silently used a different daemon', () => {
  it('says so FIRST, and names both ports', () => {
    const note = openFailureNote(4400, 4470);
    expect(note).toContain('4470');
    expect(note).toContain('4400');
    expect(
      note.indexOf('NOTE FIRST'),
      'the substitution has to precede any cause that assumes the ports match',
    ).toBeLessThan(note.indexOf('carries no Reticle SDK'));
  });

  it('tells the caller the rest does not apply', () => {
    expect(openFailureNote(4400, 4470)).toMatch(/nothing below applies/);
  });

  it('offers both ways out: move the daemon, or move the app', () => {
    const note = openFailureNote(4400, 4470);
    expect(note).toContain('serve --port 4470');
    expect(note).toMatch(/point the app at 4400/);
  });

  /** The ordinary case must not grow a paragraph about a substitution that did not happen. */
  it('says nothing about ports when the requested one was used', () => {
    const note = openFailureNote(4400, 4400);
    expect(note).not.toContain('NOTE FIRST');
    expect(note).toContain('carries no Reticle SDK');
  });

  it('never advises a bare `reticle` binary, which the npx install does not create', () => {
    expect(openFailureNote(4400, 4470)).not.toMatch(/`reticle (init|serve|open)\b/);
  });
});
