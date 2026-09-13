import { describe, expect, it } from 'vitest';
import { AppRuntime } from '../telemetry-feedback.js';
import { REALMS, isKnownRealm, realmOf, realmOfProject } from './registry.js';

/**
 * The table has to be complete, and the unknown case has to be the safe one.
 *
 * The value of gathering these facts is that a missing one becomes a compile error. That only holds
 * while the table is keyed by the enum, so the first test here is really about the SHAPE surviving:
 * somebody widening it to a partial record, or reaching for a lookup with a fallback, would give
 * every future realm the web's answers without anything going red.
 */

describe('every realm is described', () => {
  it('has a row for each runtime the wire can carry', () => {
    expect(Object.keys(REALMS).sort()).toEqual(Object.values(AppRuntime).sort());
  });

  it('and the rows disagree, which is why the table exists', () => {
    // If every realm answered the same, there would be nothing to gather and this would be
    // ceremony. Desktop and web must differ somewhere.
    expect(REALMS[AppRuntime.WEB]).not.toEqual(REALMS[AppRuntime.ELECTRON]);
    expect(REALMS[AppRuntime.ELECTRON]).not.toEqual(REALMS[AppRuntime.TAURI]);
  });
});

describe('what the facts actually say', () => {
  it('the web is a browser tab, and owns no desktop warnings', () => {
    expect(REALMS[AppRuntime.WEB].isDesktopShell).toBe(false);
    expect(REALMS[AppRuntime.WEB].ownsCoverageKinds).toBe(false);
  });

  it('both desktop realms are shells', () => {
    expect(REALMS[AppRuntime.ELECTRON].isDesktopShell).toBe(true);
    expect(REALMS[AppRuntime.TAURI].isDesktopShell).toBe(true);
  });

  it('but only Electron raises coverage warnings of its own', () => {
    // The trap this table exists to hold open. "Desktop" and "has its own coverage warnings" look
    // like the same fact and are not: an Electron renderer needs a preload script to see its IPC,
    // and Tauri's invoke is already a fetch, so it has no unobserved-IPC case to report.
    expect(REALMS[AppRuntime.ELECTRON].ownsCoverageKinds).toBe(true);
    expect(REALMS[AppRuntime.TAURI].ownsCoverageKinds).toBe(false);
    expect(REALMS[AppRuntime.TAURI].isDesktopShell).toBe(true);
  });

  it('only Tauri draws with WebKit — Electron carries its own Chromium', () => {
    // The distinction a hidden window depends on, and the one most likely to be got wrong by
    // somebody grouping "the two desktop ones" together.
    expect(REALMS[AppRuntime.TAURI].usesWebKit).toBe(true);
    expect(REALMS[AppRuntime.ELECTRON].usesWebKit).toBe(false);
  });

  it('the web keeps the baseline directory it has always had', () => {
    expect(REALMS[AppRuntime.WEB].hasOwnBaselineDirectory).toBe(false);
  });
});

describe('a session that has not said what it is', () => {
  it('is treated as the web', () => {
    // An older SDK sends no runtime. Reading silence as a desktop shell would show desktop warnings
    // to every browser tab connected by an older client.
    expect(realmOf(undefined)).toEqual(REALMS[AppRuntime.WEB]);
  });

  it('and so is a runtime from the future', () => {
    // Forward compatibility: a newer page naming a realm this build has never heard of gets the
    // answers with the fewest special cases rather than a crash or a guess.
    expect(realmOf('holodeck')).toEqual(REALMS[AppRuntime.WEB]);
  });

  it('but a realm it DOES know is looked up, not defaulted', () => {
    // The check that stops the two above from passing on a function that always returns the web.
    expect(realmOf(AppRuntime.TAURI).usesWebKit).toBe(true);
  });
});

describe('recognising a realm the page names', () => {
  it('accepts every realm in the table', () => {
    // Derived from the table rather than listed again. A list repeated elsewhere is a list that ends
    // up one entry behind, and the failure is silent: the name is dropped and the session answers
    // every later question as though the page never said what it was.
    for (const realm of Object.keys(REALMS)) expect(isKnownRealm(realm), realm).toBe(true);
  });

  it('refuses one it has never heard of', () => {
    expect(isKnownRealm('holodeck')).toBe(false);
  });

  it('and refuses silence, which is not a realm', () => {
    expect(isKnownRealm(undefined)).toBe(false);
  });

  it('agrees with the lookup: anything it refuses is treated as the web', () => {
    // The two functions answer different questions -- "do we know this name" and "what are its
    // facts" -- and they must not disagree about which names are known.
    expect(realmOf('holodeck')).toEqual(realmOf(undefined));
  });
});

describe('working out which realm a project on disk is', () => {
  const noFiles = (): boolean => false;
  const noDeps = (): boolean => false;

  it('recognises Tauri by its config file', () => {
    expect(realmOfProject((p) => 'src-tauri/tauri.conf.json' === p, noDeps)).toBe(AppRuntime.TAURI);
  });

  it('recognises Electron by the dependency, since it has no config file of its own', () => {
    expect(realmOfProject(noFiles, (d) => 'electron' === d)).toBe(AppRuntime.ELECTRON);
  });

  it('says nothing about a plain web project', () => {
    // Undefined rather than `web`: "this is an ordinary web project" and "I could not tell" are the
    // same observation from here, and returning `web` would state more than was seen.
    expect(realmOfProject(noFiles, noDeps)).toBeUndefined();
  });

  it('a config file beats a leftover dependency', () => {
    // A project can carry both. A config file exists because somebody set the project up to be that
    // kind of app; a dependency can be transitive or left behind by something that was abandoned. The
    // stronger claim wins, which is what the hand-written checks this replaces already did.
    const both = realmOfProject(
      (p) => 'src-tauri/tauri.conf.json' === p,
      (d) => 'electron' === d,
    );
    expect(both).toBe(AppRuntime.TAURI);
  });

  it('the web is deliberately unmarked, or every project would match twice', () => {
    expect(REALMS[AppRuntime.WEB].projectMarker).toBeUndefined();
  });
});
