import { describe, expect, it } from 'vitest';
import { AppRuntime } from './telemetry-feedback.js';
import { REALMS, realmOf } from './realm-registry.js';

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
