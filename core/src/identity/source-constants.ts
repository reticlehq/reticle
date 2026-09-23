/**
 * Source mapping: how a DOM node is traced back to the line of code that rendered it.
 *
 * These two are read by the build plugins, the browser SDK and the React adapter together, and they
 * change for one reason (the source-pointer feature) rather than for the dozen reasons the wire
 * contract does.
 */

/**
 * The attribute the build plugin stamps on JSX host elements as `file:line:column`, so the browser SDK
 * and the React adapter can map a DOM node back to its source file (the source-pointer feature, needed
 * on React 19 which dropped _debugSource). Read here by both packages — it was duplicated as a local
 * const in dom/addressing/source.ts AND dom/query.ts and inlined as a literal in the React adapter. The stamper
 * (@reticlehq/babel-plugin, separate build tooling) stamps this same literal and MUST match it.
 */
export const DATA_RETICLE_SOURCE_ATTR = 'data-reticle-source';

/**
 * Compile-time global carrying the project root, so the SDK can report source paths RELATIVE to the
 * repo.
 *
 * React's `_debugSource.fileName` is ABSOLUTE (`/Users/you/app/src/Counter.tsx`), while the babel
 * stamp is repo-relative (`src/Counter.tsx`). Both reach the agent as `source`, so the same product
 * emitted two different path shapes depending on which React version an app happened to be on —
 * and an absolute path from someone else's machine is noise in a report, not a pointer. Defined by
 * the build plugins, which are the only place that knows the root.
 */
export const RETICLE_ROOT_GLOBAL = '__RETICLE_ROOT__';

/**
 * Compile-time global carrying the SDK's own package version, so a version-skewed pair can name
 * itself. Defined by the build plugins, which are the only place that can read the installed
 * package's version. See `sdkVersion` on the HELLO message.
 */
export const RETICLE_SDK_VERSION_GLOBAL = '__RETICLE_SDK_VERSION__';

/**
 * Compile-time global carrying the daemon's pairing token, for connects the build plugin does not
 * write itself. The bridge requires the token even on localhost, and nothing in a browser can read
 * the file it lives in.
 *
 * Here rather than in the Vite plugin that defines it, because the DAEMON needs to recognise it
 * too. When a build's `define` substitution does not run -- Vite 8 / rolldown left all three of
 * these as raw identifiers, and `vite.define` never reaches an Astro inline script -- the SDK dials
 * with this literal string as its credential. The daemon then refuses it as a wrong token, which
 * sends the reader to check a token that was never produced. Recognising the placeholder is what
 * lets the refusal name the real cause (#996).
 */
export const RETICLE_TOKEN_GLOBAL = '__RETICLE_TOKEN__';
