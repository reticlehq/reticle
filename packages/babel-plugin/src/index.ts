import { relative } from 'node:path';
import type { PluginObj, PluginPass, types as BabelTypes } from '@babel/core';
import { DATA_RETICLE_SOURCE_ATTR } from '@reticlehq/core/source-constants';
import { isDomTag } from './dom-tags.js';

const SOURCE_ATTR = DATA_RETICLE_SOURCE_ATTR;

/**
 * Canonical marker string lives in @reticlehq/server's `init-opt-out.ts`.
 * If it changes there, change it here too — the two must stay in sync so a user
 * learns `@reticle-ignore` once, not once per surface.
 */
const OPT_OUT_MARKER = '@reticle-ignore';

/**
 * Matches the marker as a whole token — case-insensitive, with a negative lookahead
 * so `@reticle-ignored` or `@reticle-ignore-paths` do not count.
 *
 * Same semantics as `hasOptOut` in `packages/server/src/init/init-opt-out.ts`.
 */
const OPT_OUT_TOKEN = new RegExp(`${OPT_OUT_MARKER}(?![\\w-])`, 'i');

interface PluginApi {
  types: typeof BabelTypes;
}

interface ReticlePass extends PluginPass {
  /** Set once per file: true if the source carries the opt-out marker. */
  reticleIgnoreFile?: boolean;
}

/**
 * Check whether the source carries the `@reticle-ignore` marker.
 * Reads from Babel's in-memory `file.code` (already loaded) — no disk access.
 *
 * Matching semantics follow `init-opt-out.ts`: case-insensitive token match
 * with a `(?![\w-])` boundary, so `@reticle-ignored` does not count.
 */
function isReticleIgnoreFile(state: ReticlePass): boolean {
  if (undefined !== state.reticleIgnoreFile) return state.reticleIgnoreFile;
  const code = state.file?.code;
  if ('string' !== typeof code || 0 === code.length) {
    state.reticleIgnoreFile = false;
    return false;
  }
  state.reticleIgnoreFile = OPT_OUT_TOKEN.test(code);
  return state.reticleIgnoreFile;
}

/**
 * Stamps `data-reticle-source="relativeFile:line:col"` on every JSX host element (lowercase
 * tag). @reticlehq/react reads it to map a DOM node back to its source — needed on React 19,
 * which removed `_debugSource`. Intended for dev builds only.
 *
 * Skips files that carry the `@reticle-ignore` marker — a per-file opt-out for
 * generated files, snapshot-tested components, or any local reason the stamp would be wrong.
 *
 * Exported with `export =` (CommonJS module.exports) — Babel loads a plugin via `require()` and takes
 * the module object directly, so this ships as a bare `module.exports = fn` with no `__esModule`/`default`
 * interop wrapper (which some bundlers mishandle) and no named exports (which an ESM consumer's static
 * named import cannot see at runtime in a CJS module). The attribute name itself is exported from
 * `@reticlehq/core` as `DATA_RETICLE_SOURCE_ATTR` for anyone who needs it.
 */
function reticleSourcePlugin({ types: t }: PluginApi): PluginObj<ReticlePass> {
  return {
    name: 'reticle-source',
    visitor: {
      Program(_path, state) {
        // Peek at the source eagerly so the decision is cached before any JSX visit.
        isReticleIgnoreFile(state);
      },
      JSXOpeningElement(path, state: ReticlePass) {
        if (state.reticleIgnoreFile === true) return;

        const node = path.node;
        // Host elements only (e.g. <div>, <button>) — skip components (<App />).
        if (node.name.type !== 'JSXIdentifier') return;
        const tag = node.name.name;
        const first = tag[0];
        if (first === undefined || first.toLowerCase() !== first) return;
        // ...and only host elements that are DOM. React is a reconciler interface, so a lowercase
        // intrinsic can belong to react-three-fiber, react-pdf or ink, whose host instances are not
        // nodes. R3F reads a dashed prop as a pierced property path and throws from the commit
        // phase, which unmounts the entire app to a white screen. See dom-tags.ts.
        if (!isDomTag(tag)) return;

        const alreadyStamped = node.attributes.some(
          (attr) =>
            'JSXAttribute' === attr.type &&
            'JSXIdentifier' === attr.name.type &&
            attr.name.name === SOURCE_ATTR,
        );
        if (alreadyStamped) return;

        const loc = node.loc;
        if (null === loc || loc === undefined) return;

        const filename = state.filename ?? 'unknown';
        // Forward slashes always. `relative` returns the PLATFORM separator, so on Windows this
        // stamped `src\Foo.tsx:42:8` — the `file:line` the whole product hands back, with a
        // separator that matches neither the repo-relative paths every other Reticle surface emits
        // nor the ones the agent then greps for. Nothing failed loudly; the pointers were just
        // subtly the wrong string on one OS.
        const rel = relative(process.cwd(), filename).replace(/\\/g, '/');
        const value = `${rel}:${String(loc.start.line)}:${String(loc.start.column)}`;

        node.attributes.push(t.jsxAttribute(t.jsxIdentifier(SOURCE_ATTR), t.stringLiteral(value)));
      },
    },
  };
}

export = reticleSourcePlugin;
