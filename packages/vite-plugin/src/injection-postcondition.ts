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
