/**
 * One record per realm, in a table the compiler refuses to leave a hole in.
 *
 * NOT the protocol's `Realm`. That is an abstract class in `open-verification` describing what
 * a realm can DO -- eight questions an implementation answers. This describes what a realm IS LIKE:
 * four fixed traits the rest of the codebase branches on. It is a lookup table, not a specification.
 *
 * A realm is the kind of place an app runs: a browser tab, an Electron window, a Tauri window. The
 * four traits are whether it is a desktop shell, whether it draws with WebKit, whether its coverage
 * warnings are its own, and whether its visual baselines get their own directory.
 *
 * Adding a realm is one row. `Record<AppRuntime, RealmTraits>` means leaving it out is a COMPILE
 * error rather than a silent default — a scattered `if` gives a new realm the *web* answer, which
 * is the answer most likely to look plausible and be wrong. That is the whole reason this is a
 * table and not a lookup function with a fallback.
 *
 * Deliberately NOT here: anything a realm DOES rather than is. Which screenshot backend to call,
 * how to patch a build config, what a connect snippet looks like — those are code and live with the
 * code that runs them. This table holds facts you could write on an index card.
 */

import { type DeterminismProfile, Surface, type SubjectRef } from 'open-verification';
import { AppRuntime } from '@/telemetry-feedback.js';
import { PlatformProfile } from '@/wire/platform.js';

/** What Reticle needs to know about a realm that it cannot work out by looking. */
export interface RealmTraits {
  /**
   * Which of the protocol's surfaces this realm IS.
   *
   * Declared rather than derived. `surfaceOf` used to ask `isDesktopShell ? DESKTOP : WEB`, so of
   * the six surfaces the protocol names — web, desktop, mobile, service, game, device — only two
   * could ever be returned, while `DETERMINISM_BY_SURFACE` already carried a correct row for all
   * six. A mobile, service, game or device realm had no way to be NAMED even though the rules
   * governing it were written and waiting.
   *
   * A boolean answers two questions; a surface is not a question with two answers. With this here,
   * adding a domain is a row in the table below rather than an edit to a branch — and the branch is
   * the thing that would have answered `web` to everything it had not heard of.
   */
  readonly surface: Surface;
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
  /**
   * How a project on disk says it is this realm, or `undefined` when nothing marks it.
   *
   * A fact you could write on an index card, which is why it belongs here: a Tauri project has a
   * `src-tauri/tauri.conf.json`, an Electron project depends on `electron`. What to DO once you know
   * stays where it is; this only answers which realm you are looking at.
   *
   * The web has no marker, and that is the point rather than an omission. A web project is a project
   * with none of the others' markers, so giving it one would make every project match two realms.
   */
  readonly projectMarker?: { readonly file: string } | { readonly dependency: string };
}

/**
 * Every realm Reticle knows about.
 *
 * Adding one is a row here plus a value on `AppRuntime`. The compiler will not let you add the value
 * without the row, which is the point: the alternative is a lookup that quietly answers "web".
 */
export const REALMS: Record<AppRuntime, RealmTraits> = {
  [AppRuntime.WEB]: {
    surface: Surface.WEB,
    isDesktopShell: false,
    usesWebKit: false,
    ownsCoverageKinds: false,
    hasOwnBaselineDirectory: false,
  },
  [AppRuntime.ELECTRON]: {
    surface: Surface.DESKTOP,
    isDesktopShell: true,
    // No config file of its own: an Electron app is one that depends on Electron.
    projectMarker: { dependency: 'electron' },
    // Chromium, whatever the host operating system is.
    usesWebKit: false,
    ownsCoverageKinds: true,
    hasOwnBaselineDirectory: true,
  },
  [AppRuntime.TAURI]: {
    surface: Surface.DESKTOP,
    isDesktopShell: true,
    projectMarker: { file: 'src-tauri/tauri.conf.json' },
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
 * and the compiler would stop catching a runtime this package does not know.
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
/**
 * Realms a host registered at startup, for domains this package does not ship.
 *
 * `REALMS` above is a compile-checked `Record<AppRuntime, …>` and stays that way: leaving out a
 * shell this package ships must remain a compile error. But that same shape is a wall for everybody else —
 * an Android realm, a game realm, a CLI realm cannot be NAMED without a pull request against
 * `@reticlehq/core`, and a protocol meant for industries that have never heard of this repository
 * cannot require one.
 *
 * Separate map rather than a mutable `REALMS`, so a registration can never shadow or delete a
 * built-in. Extension must not mean an adopter can redefine `web`.
 */
const REGISTERED = new Map<string, RealmTraits>();

/** The prefix every extension in this protocol carries. Not decoration — see `registerRealm`. */
const EXTENSION_PREFIX = 'x-';

/**
 * Teach this process about a realm it does not ship.
 *
 * The `x-` prefix is required for two reasons that are both about the future: a third-party name
 * can never collide with one this package later ships, and a reader can tell at a glance which
 * realms this package ships and which a host added. It is the same convention `ChannelIdSchema` already
 * enforces for channels.
 *
 * Throws rather than returning a result. A realm that failed to register would answer `web` to
 * everything — the most plausible-looking wrong answer available — and the caller is a host at
 * startup, where a throw is read immediately and a silent miss is not read at all.
 *
 * CEILING, invisible from the signature: there is no host seam in the daemon. `reticle serve`
 * imports no user module, so nothing outside this repository has a moment in which to call this,
 * and every realm Reticle ships is a row in `REALMS` rather than a registration. Adding a realm
 * today means a change to `@reticlehq/core`.
 */
export function registerRealm(runtime: string, traits: RealmTraits): void {
  if (!runtime.startsWith(EXTENSION_PREFIX)) {
    throw new Error(
      `realm "${runtime}" must start with "${EXTENSION_PREFIX}" — the prefix keeps a realm this ` +
        'package might later ship from colliding with yours, and tells a reader whose realm it is.',
    );
  }
  if (Object.hasOwn(REALMS, runtime)) {
    throw new Error(`realm "${runtime}" is built in and cannot be redefined`);
  }
  REGISTERED.set(runtime, traits);
}

/** Every runtime this process understands: the built-ins, plus whatever a host registered. */
export function knownRuntimes(): string[] {
  return [...Object.keys(REALMS), ...REGISTERED.keys()];
}

/** Forget every registered realm. For tests and for a host rebuilding its own registry. */
export function resetRegisteredRealms(): void {
  REGISTERED.clear();
}

export function realmOf(runtime: string | undefined): RealmTraits {
  const name = runtime ?? '';
  if (Object.hasOwn(REALMS, name)) return REALMS[name as AppRuntime];
  return REGISTERED.get(name) ?? REALMS[AppRuntime.WEB];
}

/**
 * The protocol's surface for a realm.
 *
 * Reads `isDesktopShell` rather than testing the runtime again, which is the whole reason this
 * table exists: a third place branching on `electron || tauri` is a third place to forget a realm,
 * and the answer it would forget into is the web one -- the answer most likely to look plausible
 * and be wrong.
 *
 * An unknown or absent runtime answers `web`, like everything else here. For a surface that IS an
 * assumption rather than a fact: a `SubjectRef` requires one and the handshake carries no other
 * tell, so the error is a desktop app identified as a page, which understates the subject rather
 * than misdescribing it.
 */
export function surfaceOf(runtime: string | undefined): Surface {
  return realmOf(runtime).surface;
}

/**
 * What a subject's identity is read from.
 *
 * Structural rather than a `Session`, so the identity can be taken where a full session is not in
 * hand -- the run artifact is assembled at teardown from a narrowed view of one. Naming it is the
 * point: there is exactly ONE definition of what identifies a subject, and a second place
 * computing `surface` and `instance` its own way is how two artifacts about the same session come
 * to disagree about what was verified.
 */
export interface SubjectFacts {
  readonly id: string;
  readonly url: string;
  readonly runtime?: string | undefined;
  readonly currentDocumentId?: string | undefined;
  readonly currentEditEpoch?: number | undefined;
}

/** The protocol's identity for a connected subject. */
export function subjectOf(facts: SubjectFacts): SubjectRef {
  const epoch = facts.currentEditEpoch;
  return {
    surface: surfaceOf(facts.runtime),
    // The document id when there is one. Falling back to the session id is a WEAKER identity --
    // it survives a navigation that should have invalidated it -- so it is used only before the
    // first document is known, never as a substitute for one.
    instance: facts.currentDocumentId ?? facts.id,
    ...(epoch === undefined ? {} : { epoch }),
    locator: facts.url,
  };
}

/**
 * Which realm a project on disk is, judged only by its markers.
 *
 * A project can carry more than one marker, so precedence has to be decided rather than inherited
 * from whatever order the table happens to be written in.
 *
 * A CONFIG FILE beats a DEPENDENCY. A file like `src-tauri/tauri.conf.json` exists because somebody
 * set this project up to be that kind of app; a dependency can be transitive, vestigial, or left
 * behind by something that was tried and abandoned. The stronger claim wins, which is also what the
 * hand-written checks this replaces already did.
 *
 * Returns undefined rather than the web when nothing matches. "This is a plain web project" and "I
 * could not tell" are the same observation here, and naming it `web` would state more than was seen.
 */
export function realmOfProject(
  hasFile: (path: string) => boolean,
  hasDependency: (name: string) => boolean,
): AppRuntime | undefined {
  const marked = Object.entries(REALMS).filter(([, realm]) => realm.projectMarker !== undefined);
  for (const [runtime, realm] of marked) {
    const marker = realm.projectMarker;
    if (marker !== undefined && 'file' in marker && hasFile(marker.file))
      return runtime as AppRuntime;
  }
  for (const [runtime, realm] of marked) {
    const marker = realm.projectMarker;
    if (marker !== undefined && 'dependency' in marker && hasDependency(marker.dependency)) {
      return runtime as AppRuntime;
    }
  }
  return undefined;
}

/**
 * Which kind of surface each known shell presents.
 *
 * The bridge between the two vocabularies, kept here rather than beside `PlatformProfile` so that
 * the profile list itself depends on nothing. A connection that says which shell it is, and not
 * which surface, still gets a surface -- which is what lets an older SDK keep working.
 *
 * `Record<AppRuntime, PlatformProfile>` means a new shell cannot be added without answering this.
 */
const PROFILE_OF_RUNTIME: Record<AppRuntime, PlatformProfile> = {
  [AppRuntime.WEB]: PlatformProfile.WEB,
  // Both are a web page in somebody else's window. That they are one profile is the entire point.
  [AppRuntime.ELECTRON]: PlatformProfile.WEBVIEW,
  [AppRuntime.TAURI]: PlatformProfile.WEBVIEW,
};

/** The kind of surface a shell presents, or undefined if we have never heard of the shell. */
export function profileOfRuntime(runtime: string | undefined): PlatformProfile | undefined {
  if (runtime === undefined) return undefined;
  return PROFILE_OF_RUNTIME[runtime as AppRuntime];
}

/**
 * How each kind of surface may be DRIVEN.
 *
 * "Resume is nearly free, just re-run the prefix at 27 ms a step" is true of a browser and FALSE
 * AND DANGEROUS on hardware, where re-driving a prefix moves a physical
 * arm, costs real time, and may not be idempotent. The protocol already decides this from a declared
 * profile via `resumeStrategy`; what was missing was anywhere for server code to GET a profile,
 * because a `Realm` object is constructed only by the conformance client and the code that resumes a
 * replay has no realm to ask.
 *
 * A determinism profile is a property of the KIND of subject, not of one realm instance, so it lives
 * here beside the other facts about kinds. That is what makes the rule enforceable on the path that
 * actually resumes, today, rather than after some future wiring.
 *
 * Every surface the vocabulary names is declared. A missing entry would fall through to the web
 * answer, and the web answer is the permissive one — which is the wrong direction to be wrong in
 * when the question is "may I silently re-send this payment".
 */
export const DETERMINISM_BY_SURFACE: Record<Surface, DeterminismProfile> = {
  [Surface.WEB]: {
    reset: 'cheap',
    replayPrefix: 'free',
    time: 'injectable',
    observation: 'exact',
    actions: 'reversible',
  },
  /** A browser in a shell: the page behaves the same, the shell adds windows and menus. */
  [Surface.DESKTOP]: {
    reset: 'cheap',
    replayPrefix: 'free',
    time: 'injectable',
    observation: 'exact',
    actions: 'reversible',
  },
  /** A cold start is the reset, and it is not cheap. */
  [Surface.MOBILE]: {
    reset: 'costly',
    replayPrefix: 'costly',
    time: 'wall',
    observation: 'exact',
    actions: 'reversible',
  },
  /** A POST is not idempotent. Re-driving a prefix to reach step N re-sends everything before it. */
  [Surface.SERVICE]: {
    reset: 'costly',
    replayPrefix: 'unsafe',
    time: 'wall',
    observation: 'exact',
    actions: 'irreversible',
  },
  /** Frame-stepped and seedable, which makes a game the MOST deterministic subject here. */
  [Surface.GAME]: {
    reset: 'cheap',
    replayPrefix: 'free',
    time: 'stepped',
    observation: 'exact',
    actions: 'reversible',
  },
  /** A sensor reads a region, not a value, and an actuator cannot be un-moved. */
  [Surface.DEVICE]: {
    reset: 'costly',
    replayPrefix: 'unsafe',
    time: 'wall',
    observation: 'sampled',
    actions: 'irreversible',
  },
};

/** The declared profile for a surface. */
export function determinismFor(surface: Surface): DeterminismProfile {
  return DETERMINISM_BY_SURFACE[surface];
}
