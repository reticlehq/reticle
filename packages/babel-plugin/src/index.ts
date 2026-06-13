import { relative } from 'node:path';
import type { PluginObj, PluginPass, types as BabelTypes } from '@babel/core';

export const SOURCE_ATTR = 'data-iris-source';

interface PluginApi {
  types: typeof BabelTypes;
}

/**
 * Stamps `data-iris-source="relativeFile:line:col"` on every JSX host element (lowercase
 * tag). @iris/react reads it to map a DOM node back to its source — needed on React 19,
 * which removed `_debugSource`. Intended for dev builds only.
 */
export default function irisSourcePlugin({ types: t }: PluginApi): PluginObj<PluginPass> {
  return {
    name: 'iris-source',
    visitor: {
      JSXOpeningElement(path, state: PluginPass) {
        const node = path.node;
        // Host elements only (e.g. <div>, <button>) — skip components (<App />).
        if (node.name.type !== 'JSXIdentifier') return;
        const first = node.name.name[0];
        if (first === undefined || first !== first.toLowerCase()) return;

        const alreadyStamped = node.attributes.some(
          (attr) =>
            attr.type === 'JSXAttribute' &&
            attr.name.type === 'JSXIdentifier' &&
            attr.name.name === SOURCE_ATTR,
        );
        if (alreadyStamped) return;

        const loc = node.loc;
        if (loc === null || loc === undefined) return;

        const filename = state.filename ?? 'unknown';
        const rel = relative(process.cwd(), filename);
        const value = `${rel}:${String(loc.start.line)}:${String(loc.start.column)}`;

        node.attributes.push(t.jsxAttribute(t.jsxIdentifier(SOURCE_ATTR), t.stringLiteral(value)));
      },
    },
  };
}
