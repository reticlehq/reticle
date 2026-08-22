/**
 * Source mapping: how a DOM node is traced back to the line of code that rendered it.
 *
 * Split out of `constants.ts` — these two are read by the build plugins, the browser SDK and the
 * React adapter together, and they change for one reason (the source-pointer feature) rather than
 * for the dozen reasons the wire contract does.
 */

/**
 * The attribute the build plugin stamps on JSX host elements as `file:line:column`, so the browser SDK
 * and the React adapter can map a DOM node back to its source file (the source-pointer feature, needed
 * on React 19 which dropped _debugSource). Read here by both packages — it was duplicated as a local
 * const in dom/source.ts AND dom/query.ts and inlined as a literal in the React adapter. The stamper
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
 * The CommonJS view of the source-mapping contract.
 *
 * `@reticlehq/babel-plugin` is plain CJS tooling — Babel loads a plugin with `require()` — so it
 * cannot import this module's ESM build. It used to declare its own `const SOURCE_ATTR =
 * 'data-reticle-source'`, kept in step with the constant above by a comment on each side pointing
 * at the other. If those two ever drift, source mapping breaks on the React 19 / Next SWC path,
 * which is the plugin's whole job, and nothing can see it: the browser reads the attribute core
 * names, the plugin writes the attribute it names itself, and both keep passing.
 *
 * `scripts/gen-source-contract.mjs` emits `dist/source-contract.cjs` from THIS record at build
 * time, so the plugin requires the same value it would have imported. Same mechanism as
 * `DESKTOP_CONTRACT`, for the same reason: remove the copy rather than police it.
 */
export const SOURCE_CONTRACT = {
  DATA_RETICLE_SOURCE_ATTR,
} as const;
