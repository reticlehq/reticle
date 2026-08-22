import { relative } from 'node:path';
import type { PluginObj, PluginPass, types as BabelTypes } from '@babel/core';

/**
 * The attribute this plugin stamps, taken from @reticlehq/core rather than restated here.
 *
 * `require`, not `import`: this package is plain CommonJS tooling — Babel loads a plugin with
 * `require()` — so it cannot load core's ESM build. `@reticlehq/core/source-contract` is the
 * CommonJS view, generated from the same TypeScript constant the browser SDK and the React adapter
 * read. This used to be a local literal kept in step by a comment on each side, and a drift between
 * the two breaks all source mapping on the React 19 / Next SWC path without any gate seeing it.
 */
// `require`, and not a plain `import`, for a TypeScript reason rather than a runtime one: this
// package compiles with `moduleResolution: Node10` (see tsconfig.json), which predates subpath
// `exports` and cannot resolve `@reticlehq/core/source-contract` at all. Node's own resolver
// honours the export map fine, which is how `@reticlehq/electron` consumes its sibling contract.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DATA_RETICLE_SOURCE_ATTR: SOURCE_ATTR } = require('@reticlehq/core/source-contract') as {
  DATA_RETICLE_SOURCE_ATTR: string;
};

interface PluginApi {
  types: typeof BabelTypes;
}

/**
 * Stamps `data-reticle-source="relativeFile:line:col"` on every JSX host element (lowercase
 * tag). @reticlehq/react reads it to map a DOM node back to its source — needed on React 19,
 * which removed `_debugSource`. Intended for dev builds only.
 *
 * Exported with `export =` (CommonJS module.exports) — Babel loads a plugin via `require()` and takes
 * the module object directly, so this ships as a bare `module.exports = fn` with no `__esModule`/`default`
 * interop wrapper (which some bundlers mishandle) and no named exports (which an ESM consumer's static
 * named import cannot see at runtime in a CJS module). The attribute name itself is exported from
 * `@reticlehq/core` as `DATA_RETICLE_SOURCE_ATTR` for anyone who needs it.
 */
function reticleSourcePlugin({ types: t }: PluginApi): PluginObj<PluginPass> {
  return {
    name: 'reticle-source',
    visitor: {
      JSXOpeningElement(path, state: PluginPass) {
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
