/**
 * One record per realm, in a table the compiler refuses to leave a hole in.
 *
 * A realm is the kind of place an app runs: a browser tab, an Electron window, a Tauri window. Most
 * of Reticle does not care which — a click is a click and a failed request is a failed request — but
 * a handful of decisions genuinely differ, and until now each was a separate `if` in whichever file
 * needed it.
 *
 * Four of them, found by reading every branch on the runtime rather than by guessing:
 *
 *   - whether it is a desktop shell, asked in two places;
 *   - whether it draws with WebKit, which changes what a hidden window does;
 *   - whether its coverage warnings are its own and must not be shown for other realms;
 *   - whether its visual baselines get their own directory.
 *
 * Scattered, each is easy to write and easy to forget. Adding a fourth realm meant finding all four
 * with a grep and hoping the grep was complete — and a missed one does not break loudly, it quietly
 * gives a new realm the *web* answer, which is the answer most likely to look plausible and be wrong.
 *
 * Gathered here, adding a realm is one row. `Record<AppRuntime, Realm>` means leaving it out is a
 * COMPILE error rather than a silent default, which is the whole reason this is a table and not a
 * lookup function with a fallback.
 *
 * What is deliberately NOT here: anything a realm does rather than is. Which screenshot backend to
 * call, how to patch a build config, what a connect snippet looks like — those are code, they live
 * with the code that runs them, and pulling them in would turn one honest table into a plugin system
 * nobody asked for. This table holds facts you could write on an index card.
 */

import { AppRuntime } from './telemetry-feedback.js';

/** What Reticle needs to know about a realm that it cannot work out by looking. */
export interface Realm {
  /**
   * Does the app run in a window of its own, rather than a browser tab?
   *
   * Decides whether advice about dev servers and tabs applies, and whether desktop-only coverage
   * warnings are worth showing.
   */
  readonly isDesktopShell: boolean;
  /**
   * Does it draw with WebKit?
   *
   * A hidden WebKit window stops executing while still answering screenshots, so a command that
   * times out there needs different advice: park the window off-screen rather than hiding it.
   */
  readonly usesWebKit: boolean;
  /**
   * Does it raise coverage warnings that make no sense for any other realm?
   *
   * Only Electron does, and this is narrower than "is a desktop shell", which is what it looks like
   * at first glance. The warnings in question are about IPC going unobserved, and they exist because
   * an Electron renderer needs a preload script to see its own IPC: without one, everything is
   * unobserved and nothing says so.
   *
   * Tauri is a desktop shell and raises none of them, because its `invoke` travels as an ordinary
   * fetch to a custom protocol and is already visible. A browser tab has no IPC at all.
   *
   * Reported for the wrong realm, a missing-preload warning reads as an un-instrumented app -- which
   * is how a plain Vite page once looked like a broken Electron install.
   */
  readonly ownsCoverageKinds: boolean;
  /**
   * Do its visual baselines live in a directory of their own?
   *
   * The web is the default and keeps the top-level directory it has always had; anything else is
   * filed under its own name, so two realms of one project cannot overwrite each other's pictures.
   */
  readonly hasOwnBaselineDirectory: boolean;
}

/**
 * Every realm Reticle knows about.
 *
 * Adding one is a row here plus a value on `AppRuntime`. The compiler will not let you add the value
 * without the row, which is the point: the alternative is a lookup that quietly answers "web".
 */
export const REALMS: Record<AppRuntime, Realm> = {
  [AppRuntime.WEB]: {
    isDesktopShell: false,
    usesWebKit: false,
    ownsCoverageKinds: false,
    hasOwnBaselineDirectory: false,
  },
  [AppRuntime.ELECTRON]: {
    isDesktopShell: true,
    // Chromium, whatever the host operating system is.
    usesWebKit: false,
    ownsCoverageKinds: true,
    hasOwnBaselineDirectory: true,
  },
  [AppRuntime.TAURI]: {
    isDesktopShell: true,
    // The system webview: WKWebView on macOS, WebKitGTK on Linux.
    usesWebKit: true,
    // A desktop shell that raises none of its own coverage warnings. Its `invoke` is a fetch to a
    // custom protocol, so the IPC is already observed and there is no unobserved-IPC case to report.
    // The obvious grouping -- "the two desktop ones behave alike" -- is wrong here.
    ownsCoverageKinds: false,
    hasOwnBaselineDirectory: true,
  },
};

/**
 * Is this a realm this build knows about?
 *
 * Asked where a runtime arrives from the page and has to be accepted or ignored. Derived from the
 * table rather than listed again, because a list repeated somewhere else is a list that gets one
 * entry behind: a realm missing from it is not rejected loudly, its name is simply dropped, and every
 * later question about that session answers as though the page never said what it was.
 *
 * Written as a type guard so the caller gets the narrowing the hand-written chain of comparisons gave
 * it for free. Without that, replacing the chain would have widened a field back to a plain string,
 * and the compiler would have stopped catching a runtime that is not one of ours.
 */
export function isKnownRealm(runtime: string | undefined): runtime is AppRuntime {
  return runtime !== undefined && Object.hasOwn(REALMS, runtime);
}

/**
 * The facts for a realm, or the web's, when the page has not said which it is.
 *
 * An older SDK sends no runtime at all. Reading that silence as a desktop shell would show desktop
 * warnings to every browser tab connected by an older client, so the unknown case answers as the web:
 * the realm with the fewest special cases, and the one almost every unknown session actually is.
 *
 * Takes a plain string rather than the enum, deliberately. What arrives here came off the wire from
 * a page that may be newer than this build, so "a realm I have never heard of" is a case that has to
 * exist -- and typing the parameter as the enum would describe a guarantee the wire cannot make.
 */
export function realmOf(runtime: string | undefined): Realm {
  const known = Object.hasOwn(REALMS, runtime ?? '')
    ? REALMS[runtime as AppRuntime]
    : REALMS[AppRuntime.WEB];
  return known;
}
