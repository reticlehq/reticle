import { relative } from 'node:path';
import type { PluginObj, PluginPass, types as BabelTypes } from '@babel/core';
import { DATA_RETICLE_SOURCE_ATTR } from '@reticlehq/core/source-constants';

const SOURCE_ATTR = DATA_RETICLE_SOURCE_ATTR;

/** Matches `// @reticle-ignore` as the first non-empty line of a file. */
const RETICLE_IGNORE_RE = /^\s*\/\/\s*@reticle-ignore\s*/;

interface PluginApi {
  types: typeof BabelTypes;
}

interface ReticlePass extends PluginPass {
  /** Set once per file: true if `// @reticle-ignore` is the first non-empty line. */
  reticleIgnoreFile?: boolean;
}

/**
 * Check whether the source's first non-empty line is `// @reticle-ignore`.
 * Reads from Babel's in-memory `file.code` (already loaded) — no disk access.
 */
function isReticleIgnoreFile(state: ReticlePass): boolean {
  if (state.reticleIgnoreFile !== undefined) return state.reticleIgnoreFile;
  const code = state.file?.code;
  if (typeof code !== 'string' || code.length === 0) {
    state.reticleIgnoreFile = false;
    return false;
  }
  const firstLine = code.split('\n', 1)[0] ?? '';
  state.reticleIgnoreFile = RETICLE_IGNORE_RE.test(firstLine);
  return state.reticleIgnoreFile;
}

/**
 * Stamps `data-reticle-source="relativeFile:line:col"` on every JSX host element (lowercase
 * tag). @reticlehq/react reads it to map a DOM node back to its source — needed on React 19,
 * which removed `_debugSource`. Intended for dev builds only.
 *
 * Skips files whose first non-empty line is `// @reticle-ignore` — a per-file opt-out for
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
        // Peek at the first line eagerly so the decision is cached before any JSX visit.
        isReticleIgnoreFile(state);
      },
      JSXOpeningElement(path, state: ReticlePass) {
        if (state.reticleIgnoreFile === true) return;

        const node = path.node;
        // Host elements only (e.g. <div>, <button>) — skip components (<App />).
        if (node.name.type !== 'JSXIdentifier') return;
        const first = node.name.name[0];
        if (first === undefined || first !== first.toLowerCase()) return;

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
