/**
 * The console channel's payload vocabulary, and the global the build plugin's pre-attach error
 * buffer lives on. Split out of `constants.ts` at its 1000-line cap (#1540).
 */

/**
 * The payload field set to `true` on an error the page raised BEFORE the SDK attached. The build
 * plugin's error buffer held it, and the SDK reported it when it attached (see
 * RETICLE_PRE_ATTACH_ERRORS). A name of its own, and not only a CONSOLE_EVENT member, because the
 * SDK writes it: importing the whole object would put the server's vocabulary in every page load.
 */
export const PRE_ATTACH_FIELD = 'preAttach';
/** The payload field reporting how many pre-attach errors the buffer did not keep — loss, declared. */
export const DROPPED_PRE_ATTACH_FIELD = 'droppedPreAttach';

/**
 * Payload fields and `kind` values on console/error events that the AGENT reads back through
 * `reticle_console`. The console payload is passthrough rather than closed, so these are named
 * here instead of schema-enforced: a wire string a server writes inline is one a rename
 * half-lands, with the agent reading a field that quietly stopped arriving.
 */
export const CONSOLE_EVENT = {
  /** The payload field naming what kind of console/error event it is (`resource`, `pageerror`, ...). */
  KIND: 'kind',
  /** The kind for an uncaught error the SERVER observed through the page's own browser handle. */
  PAGE_ERROR: 'pageerror',
  /** The payload field reporting how many buffered page errors were dropped — loss, declared. */
  DROPPED_PAGE_ERRORS: 'droppedPageErrors',
  /** See PRE_ATTACH_FIELD. */
  PRE_ATTACH: PRE_ATTACH_FIELD,
  /** See DROPPED_PRE_ATTACH_FIELD. */
  DROPPED_PRE_ATTACH: DROPPED_PRE_ATTACH_FIELD,
} as const;

/**
 * Global where the build plugin's inline error buffer keeps the errors a page raises before the SDK
 * attaches: uncaught errors, failed script and resource loads, unhandled rejections and
 * `console.error` calls (see the vite plugin's PRE_ATTACH_ERRORS_SOURCE).
 *
 * Holds `{ open, drain }`. When the SDK's console observer installs it calls
 * `drain(onError, onRejection, onConsole, dropped)` once: the buffer stops keeping and hands each
 * entry to the SDK's own handler. The SDK marks what arrives during that call with
 * PRE_ATTACH_FIELD itself, and takes only a positive integer count through `dropped`. A page that Reticle
 * drives has RETICLE_EARLY_CAPTURE instead, and the buffer then does not install, so one error is
 * never kept twice. The value is short on purpose: the SDK pays for it on every page load.
 */
export const RETICLE_PRE_ATTACH_ERRORS = '__reticlePreAttach';
