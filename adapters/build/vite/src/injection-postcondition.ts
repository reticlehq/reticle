/**
 * The check that says whether `reticle.connect()` actually made it into the page, and what to say
 * when it did not.
 *
 * These three messages live together because choosing between them is the whole subtlety. Each says
 * exactly as much as the plugin actually knows and no more, and getting that wrong in either
 * direction has cost real users:
 *
 *  - Claim "this is broken" when it is not, and the tool whose entire pitch is that it does not
 *    raise false alarms has just raised one.
 *  - Say nothing when it IS broken, and someone waits twenty minutes for a session that can never
 *    arrive.
 */

import { RETICLE_VITE_PLUGIN_NAME } from './plugin-name.js';

/**
 * How long to wait before concluding that the connect script never made it in.
 *
 * Generous on purpose: the browser has to request the entry, and a cold dev server transforming a
 * large app can take a moment. A false warning would train people to ignore a real one.
 */
export const DEV_INJECTION_GRACE_MS = 10_000;

/**
 * The BUILD message. A build always runs every transform, so "my transform never ran" and "the
 * bundle has no connect()" are the same statement there, and stating it as a certainty is correct.
 */
export const notInjectedMessage = (): string =>
  `[${RETICLE_VITE_PLUGIN_NAME}] could not inject reticle.connect(): the HTML entry module was ` +
  'never matched, so this app carries no instrumentation and will never connect. Check that ' +
  'index.html references your entry with a <script type="module" src="...">, or pass ' +
  '`inject: false` and call reticle.connect({ token: __RETICLE_TOKEN__ }) yourself. The plugin ' +
  'still inlines that define; a connect without it is refused.';

/**
 * The DEV message, which must be weaker — and this is the whole reason the two are separate.
 *
 * In serve, `injected` records "my transform ran THIS session", which is not the same as "the app
 * has no connect()". Vite serves an unchanged module straight from its transform cache, so on a
 * warm cache the transform never runs, the flag stays false, and the old wording announced that
 * the app "will never connect" while the served entry demonstrably contained the injection —
 * verified by fetching it from the dev server. A false alarm, in the tool whose entire argument is
 * that it does not raise them.
 *
 * So dev reports what it actually knows: unconfirmed, with the benign explanation first.
 */
export const unconfirmedInjectionMessage = (): string =>
  `[${RETICLE_VITE_PLUGIN_NAME}] could not confirm reticle.connect() was injected: the HTML entry ` +
  'module was not transformed this session. That is expected when Vite served it from its ' +
  'transform cache. If the app does not appear in `reticle status`, restart the dev server with ' +
  '`--force` to bypass the cache, then check that index.html references your entry with a ' +
  '<script type="module" src="...">.';

/**
 * The web message.
 *
 * On the web the connect script is added by `transformIndexHtml`. A framework that renders its own
 * HTML never calls that hook, so the script is never added and the app never appears in
 * `reticle status`. Known examples: SvelteKit, Nuxt, Astro, React Router in framework mode and
 * TanStack Start. Each was found the same way — a user waiting on a session that could never
 * arrive — so the plain-language cause comes first and the fix comes second.
 */
export const htmlHookNeverRanMessage = (): string =>
  `[${RETICLE_VITE_PLUGIN_NAME}] this app will never connect: the dev server never asked this ` +
  'plugin to transform any HTML, so reticle.connect() was never added to the page. That usually ' +
  'means your framework renders its own HTML instead of serving index.html — SvelteKit, Nuxt, ' +
  'Astro, React Router (framework mode) and TanStack Start all do. Fix: import ' +
  "'@reticlehq/browser' and call reticle.connect({ token: __RETICLE_TOKEN__ }) yourself from your " +
  'app entry file, and pass `inject: false` to this plugin so the two do not both try.';

/**
 * The state behind those three messages, and the rules for reaching each one.
 *
 * Extracted from the plugin factory when `index.ts` crossed the line cap, and it belongs here
 * rather than anywhere else: this file's header already argues that choosing BETWEEN these
 * messages is the whole subtlety, and the choosing was happening a thousand lines away from the
 * wording it chose. The flags are small, they are only ever read by these four functions, and every
 * one of the defects in this area has been a rule about when to speak rather than a bug in the
 * speaking.
 */
export interface InjectionWatchDeps {
  /** Desktop builds keep the certainty; web dev does not. See the two messages above. */
  readonly desktop: boolean;
  /** `inject: false` means the user wires connect() themselves; the plugin has no opinion then. */
  readonly inject: boolean;
  /** Whether the desktop entry module was transformed. Read late: it flips during the session. */
  readonly injected: () => boolean;
  /** Whether Vite ever asked us to transform the app's HTML. Read late, for the same reason. */
  readonly htmlTransformed: () => boolean;
  readonly warn: (message: string) => void;
  /** Injected so a test does not wait ten real seconds. Defaults to the module-level timer. */
  readonly schedule?: (run: () => void, ms: number) => void;
}

export interface InjectionWatch {
  /** Record a browser asking for a page, and start the grace period from there. */
  noteHtmlRequest: () => void;
  /** A navigation, as opposed to the module and asset fetches Vite serves constantly. */
  isDocumentRequest: (req: { headers?: { accept?: string | undefined } | undefined }) => boolean;
  checkHtmlHookRan: () => void;
  checkInjected: () => void;
  /** Defer the desktop check past the HTML response, which lands before the entry module. */
  armDesktopCheck: () => void;
}

const defaultSchedule = (run: () => void, ms: number): void => {
  const timer = setTimeout(run, ms);
  // Never hold a dev server open on account of a warning it may not even need to print.
  (timer as { unref?: () => void }).unref?.();
};

export function createInjectionWatch(deps: InjectionWatchDeps): InjectionWatch {
  /**
   * Has a browser actually asked this dev server for a PAGE?
   *
   * The fact that makes "the HTML hook never ran" mean anything. `transformIndexHtml` only runs when
   * a document is requested, so on a dev server nobody has opened it has correctly never run — and
   * a check that cannot tell that apart from a framework owning its own HTML will call a perfectly
   * healthy app permanently broken. That is what it did: the timer was armed at server boot, so ten
   * seconds after startup an unopened dev server was told its app would never connect.
   */
  let htmlRequested = false;

  const isDocumentRequest = (req: {
    headers?: { accept?: string | undefined } | undefined;
  }): boolean => true === req.headers?.accept?.includes('text/html');

  /**
   * Warn when the HTML hook never ran. NOT scheduled from `transformIndexHtml` — a hook that never
   * runs would never arm its own check, and it would be unreachable in exactly the case it exists
   * for. It hangs off the first request instead: independent of the hook, but still evidence-based.
   *
   * `htmlRequested` is re-checked here rather than only at the arming site. The timer is one caller;
   * this states the precondition where the claim is actually made, which is where somebody reading
   * `warn(htmlHookNeverRanMessage())` needs to see it.
   */
  const checkHtmlHookRan = (): void => {
    if (deps.desktop || !deps.inject || deps.htmlTransformed()) return;
    // Nobody has opened the app. That says nothing about whether it can connect.
    if (!htmlRequested) return;
    deps.warn(htmlHookNeverRanMessage());
  };

  /**
   * Note a document request, and start the clock from THERE.
   *
   * The grace period is meant to cover "the browser asked, so the transform should have happened by
   * now". Measured from server start it was covering "the server booted", which is a question about
   * the developer's attention rather than about the app.
   */
  const noteHtmlRequest = (): void => {
    if (htmlRequested) return;
    htmlRequested = true;
    (deps.schedule ?? defaultSchedule)(checkHtmlHookRan, DEV_INJECTION_GRACE_MS);
  };

  /** Warn (never throw) in dev — a running dev server should report the doubt, not die of it. */
  const checkInjected = (): void => {
    if (!deps.desktop || !deps.inject || deps.injected()) return;
    deps.warn(unconfirmedInjectionMessage());
  };

  /**
   * In serve the HTML is sent BEFORE the browser requests the entry module, so asserting at html
   * time would fire on every healthy start. Deferred here rather than at the call site, so that
   * every "when may this speak" rule in the plugin sits in the one file that argues about them.
   */
  const armDesktopCheck = (): void => {
    (deps.schedule ?? defaultSchedule)(checkInjected, DEV_INJECTION_GRACE_MS);
  };

  return { noteHtmlRequest, isDocumentRequest, checkHtmlHookRan, checkInjected, armDesktopCheck };
}
