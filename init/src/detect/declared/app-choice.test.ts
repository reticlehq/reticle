/**
 * A monorepo with several apps had no way to answer.
 *
 * `reticle init` at a workspace root refuses to guess between `web/`, `admin/`, `space/`, … which is
 * correct — instrumenting one silently would leave the others unverified while reporting success.
 * But refusing is only half an answer if there is no way to say which one, and there wasn't: the
 * message said "re-run inside the one you want", which does not work from a script, a CI step, or an
 * agent that cannot change directory.
 *
 * `--app <dir>` is the missing half.
 */

import { describe, expect, it } from 'vitest';
import { chooseWorkspaceApp, withoutTrailingSlashes } from './app-choice.js';

const APPS = ['web', 'admin', 'packages/editor'];

describe('choosing which app to wire', () => {
  it('takes the one named, when it is really there', () => {
    expect(chooseWorkspaceApp('web', APPS)).toEqual({ ok: true, app: 'web' });
  });

  it('accepts a nested path exactly as it was listed', () => {
    expect(chooseWorkspaceApp('packages/editor', APPS)).toEqual({
      ok: true,
      app: 'packages/editor',
    });
  });

  it('tolerates a trailing slash, which is what tab-completion produces', () => {
    expect(chooseWorkspaceApp('web/', APPS)).toEqual({ ok: true, app: 'web' });
  });

  it('refuses a name that is not one of the apps, and lists the real ones', () => {
    const result = chooseWorkspaceApp('frontend', APPS);
    expect(result.ok).toBe(false);
    // Naming the candidates is the difference between one retry and a guessing game.
    expect(false === result.ok && result.message).toContain('web');
    expect(false === result.ok && result.message).toContain('frontend');
  });

  it('refuses when there are no apps at all, rather than accepting anything', () => {
    expect(chooseWorkspaceApp('web', []).ok).toBe(false);
  });

  it('is undecided when no app was named — the caller keeps its existing behaviour', () => {
    expect(chooseWorkspaceApp(undefined, APPS)).toEqual({ ok: true, app: undefined });
  });
});

/**
 * The trim replaced a `/\/+$/` regex that CodeQL flagged as polynomial ReDoS. Behaviour must be
 * identical, including the cases a loop is easy to get wrong: a path that is nothing but slashes,
 * and one with no trailing slash at all.
 */
describe('trimming the slashes tab-completion adds', () => {
  it('matches what the regex did, including the edges', () => {
    expect(withoutTrailingSlashes('apps/web/')).toBe('apps/web');
    expect(withoutTrailingSlashes('apps/web///')).toBe('apps/web');
    expect(withoutTrailingSlashes('apps/web')).toBe('apps/web');
    expect(withoutTrailingSlashes('')).toBe('');
    expect(withoutTrailingSlashes('/')).toBe('');
    expect(withoutTrailingSlashes('///')).toBe('');
    // An interior run is not a trailing one and must survive.
    expect(withoutTrailingSlashes('a//b/')).toBe('a//b');
  });

  it('is linear, so a long run of slashes cannot stall it', () => {
    expect(withoutTrailingSlashes(`${'/'.repeat(200_000)}x`)).toBe(`${'/'.repeat(200_000)}x`);
  });
});
