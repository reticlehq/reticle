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
import { chooseWorkspaceApp } from './app-choice.js';

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
 * Discovery can miss a real app — a declared workspace does not cover it, or it sits two directories
 * under a parent nothing walks that deep into (#682) — and refusing `--app` for exactly the same
 * reason left no way in at all. An explicit path is an instruction, not a suggestion: if it has its
 * own package.json, that settles it regardless of what discovery found.
 */
describe('an explicit --app that discovery missed', () => {
  it('is accepted when it has a package.json of its own', () => {
    const hasManifest = (dir: string): boolean => 'frontend' === dir;
    expect(chooseWorkspaceApp('frontend', APPS, hasManifest)).toEqual({
      ok: true,
      app: 'frontend',
    });
  });

  it('is still refused when nothing is there at all', () => {
    const hasManifest = (): boolean => false;
    expect(chooseWorkspaceApp('frontend', APPS, hasManifest).ok).toBe(false);
  });

  it('does not need the check when the name was already discovered', () => {
    // hasManifest is not even asked — a discovered name is already trusted.
    expect(chooseWorkspaceApp('web', APPS, () => false)).toEqual({ ok: true, app: 'web' });
  });
});
