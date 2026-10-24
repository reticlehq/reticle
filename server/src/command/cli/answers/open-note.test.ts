import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { openFailureNote, openLaunchFailureNote } from './open-note.js';

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

  it('leads with a refusal the daemon recorded, and does not tell the caller to run init', () => {
    const refusal =
      'no browser session connected: the page at http://localhost:5173 dialled this daemon and was REFUSED because the wire contract does not match; fix: restart the daemon.';
    const note = openFailureNote(4400, 4400, refusal);
    expect(note.startsWith(refusal)).toBe(true);
    expect(note).not.toContain('carries no Reticle SDK');
  });

  it('still names a missing SDK when the daemon recorded no refusal', () => {
    const note = openFailureNote(
      4400,
      4400,
      'no browser session connected. The app carries no Reticle SDK yet.',
    );
    expect(note).toContain('carries no Reticle SDK');
    expect(note).not.toContain('wire contract');
  });

  it('states a substituted port before the refusal', () => {
    const refusal = 'the page dialled this daemon and was REFUSED because the token is stale.';
    const note = openFailureNote(4400, 4470, refusal);
    expect(note.indexOf('NOTE FIRST')).toBeLessThan(note.indexOf(refusal));
    expect(note).not.toContain('carries no Reticle SDK');
  });
});

describe('reticle open, when the OS browser launcher fails', () => {
  it('offers the Reticle-owned browser lease with the URL', () => {
    const note = openLaunchFailureNote('http://localhost:5173', 'xdg-open');
    expect(note).toContain('`xdg-open`');
    expect(note).toContain(`${ReticleTool.RUN} { tool: "${ReticleTool.LEASE}"`);
    expect(note).toContain('action: "acquire"');
    expect(note).toContain('url: "http://localhost:5173"');
  });
});
