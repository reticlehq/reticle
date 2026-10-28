/**
 * The zero-install reader: how a page whose app never ran `init` still reaches a verdict.
 *
 * `@reticlehq/browser` builds itself into one file (`dist/reticle-inject.js`). The daemon reads that
 * file as TEXT and evaluates it in a leased page that never connected, so the server never imports DOM
 * code and the page needs no build step. What comes back is an ordinary session that reports no
 * framework adapter and no source mapping, which is the honest description of what it can see.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** The subpath `@reticlehq/browser` exports its single-file build under. */
const READER_SPECIFIER = '@reticlehq/browser/inject';

export interface InjectedConnect {
  url: string;
  /** Absent when this daemon runs without a pairing token; the bridge then asks for none. */
  token?: string;
}

/**
 * The connect options a page is given when WE supply the connection rather than the app.
 *
 * One builder for both injection paths — this one, and re-pointing an SDK a hosted preview already
 * ships (`real-input.ts`) — so the two cannot come to disagree about what a daemon-driven page needs.
 */
export function injectedConnectArgs(opts: InjectedConnect): Record<string, unknown> {
  return {
    allowNonLocalhost: true,
    // Lets a page's own SDK take this token when the bridge refused the one its build baked in.
    lease: true,
    ...(opts.token === undefined ? {} : { token: opts.token }),
    url: opts.url,
  };
}

/** What the reader script returns when it did nothing, because the page is not an HTML document. */
export const READER_NOT_HTML = 'reticle:not-html-document';

/** The document types that the reader runs on. `document.contentType` is set before the root element. */
const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

/*
 * Stop on a page that is not an HTML document, for example an `.svg`. The bundle needs an HTML DOM;
 * #1701 reports `Cannot read properties of null (reading 'appendChild')` on an SVG. The check
 * reads `document.contentType`, because an init script runs before the parser makes the root
 * element. The check binds no name, so it cannot collide with a name that the bundle declares.
 */
const NOT_HTML_GUARD =
  `if (globalThis.document !== undefined && !${JSON.stringify(HTML_CONTENT_TYPES)}.includes(globalThis.document.contentType)) ` +
  `return ${JSON.stringify(READER_NOT_HTML)};`;

/*
 * Keep what the page says before the SDK's observers exist, and hand it to them after `connect()`.
 *
 * The observers install in `connect()`, which waits for DOMContentLoaded (below). The app's start-up
 * scripts run before that, so a console error or an uncaught error while the page loaded was not
 * seen, and a page that crashed at start-up gave a clean capture. Only the reader does this: it is
 * installed before the page's scripts, and an app's own SDK connects from inside them.
 *
 * Kept in the order the page said it: `console.error` calls, uncaught script errors and unhandled
 * rejections. After `connect()`, each console error is said again through the patched console with
 * the native print off, so the console shows it once. Each error event is dispatched again on
 * `window`, where the SDK listens. The app's own error listeners see a replayed error a second time.
 * A resource that failed to load is not kept: the network observer reads it from resource timing.
 */
const EARLY_KEEP =
  'if ("function" === typeof globalThis.addEventListener && globalThis.console !== undefined) {\n' +
  'const early = { said: [], replaying: false };\n' +
  'globalThis.__reticleEarly = early;\n' +
  'const nativeError = globalThis.console.error;\n' +
  'globalThis.console.error = function (...args) {\n' +
  '  if (early.said !== null) early.said.push(args);\n' +
  '  if (!early.replaying) return nativeError.apply(this, args);\n' +
  '};\n' +
  'early.keep = (e) => { if (early.said !== null && (e.type !== "error" || e instanceof globalThis.ErrorEvent)) early.said.push(e); };\n' +
  'globalThis.addEventListener("error", early.keep, true);\n' +
  'globalThis.addEventListener("unhandledrejection", early.keep);\n' +
  '}';

const EARLY_REPLAY =
  'const early = globalThis.__reticleEarly;\n' +
  'if (early !== undefined) {\n' +
  '  globalThis.__reticleEarly = undefined;\n' +
  '  globalThis.removeEventListener("error", early.keep, true);\n' +
  '  globalThis.removeEventListener("unhandledrejection", early.keep);\n' +
  '  const said = early.said;\n' +
  '  early.said = null;\n' +
  '  for (const item of said) {\n' +
  '    if (Array.isArray(item)) {\n' +
  '      early.replaying = true;\n' +
  '      try { globalThis.console.error(...item); } finally { early.replaying = false; }\n' +
  '    } else if ("error" === item.type) {\n' +
  '      globalThis.dispatchEvent(new globalThis.ErrorEvent("error", { message: item.message, filename: item.filename, lineno: item.lineno, colno: item.colno, error: item.error }));\n' +
  '    } else {\n' +
  '      globalThis.dispatchEvent(new globalThis.PromiseRejectionEvent("unhandledrejection", { promise: item.promise, reason: item.reason }));\n' +
  '    }\n' +
  '  }\n' +
  '}';

/*
 * Connect once the DOM exists. The reader also runs as an init script on every later document of the
 * lease, before the parser makes <head> and <body>. `connect()` mounts page UI before it dials the
 * bridge, so it threw there and never dialled: every full navigation after the first page lost the
 * lease's session (#1897). The bundle still loads at once, so the observers start early.
 */
const CONNECT_WHEN_DOM_READY = (args: string): string =>
  `const connect = () => { globalThis.__reticleInstance.connect(${args}); ${EARLY_REPLAY} };\n` +
  `if (globalThis.document !== undefined && 'loading' === globalThis.document.readyState) ` +
  `globalThis.document.addEventListener('DOMContentLoaded', connect, { once: true });\n` +
  `else connect();`;

/**
 * The script for a page: install the SDK if the page has none, then connect it to this daemon.
 *
 * The guard is on the SINGLETON, not on a timer: a page that loaded its own SDK already holds
 * `__reticleInstance`, and evaluating a second copy would register a second session for one tab.
 * `connect` is a no-op once connected, so calling it on the page's own instance is safe, except that
 * the `lease` mark lets that instance replace a token the bridge refused.
 */
export function zeroInstallScript(bundle: string, opts: InjectedConnect): string {
  const args = JSON.stringify(injectedConnectArgs(opts));
  return `(() => {\n${NOT_HTML_GUARD}\nif (!globalThis.__reticleInstance) {\n${EARLY_KEEP}\n${bundle}\n}\n${CONNECT_WHEN_DOM_READY(args)}\n})();`;
}

/** The page is not an HTML document, so the lease did not give it the zero-install reader. */
export class NotHtmlDocumentError extends Error {
  constructor() {
    super('The page is not an HTML document, so the zero-install reader did not run.');
    this.name = 'NotHtmlDocumentError';
  }
}

let cached: string | null | undefined;

/**
 * The single-file build, or undefined when this install has none.
 *
 * Read once and kept: it is ~450KB and identical for every lease. Absent means an older browser
 * package or a broken install, and the caller then behaves exactly as it did before this existed.
 */
export function readReaderBundle(): string | undefined {
  if (cached === undefined) {
    try {
      cached = readFileSync(createRequire(import.meta.url).resolve(READER_SPECIFIER), 'utf8');
    } catch {
      cached = null;
    }
  }
  return cached ?? undefined;
}
