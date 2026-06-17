/**
 * Pure, conservative patcher for a Vite config: add the `@syrin/iris/vite` import and drop
 * `iris()` into the `plugins` array. Only handles the obvious, common shape — anything ambiguous
 * bails to a `manual` result so we never half-edit a build config (a broken config is worse than a
 * documented manual step).
 */

export const VITE_IMPORT = "import { iris } from '@syrin/iris/vite';";
const IRIS_PLUGIN_CALL = 'iris()';
const IRIS_MARKER = '@syrin/iris/vite';
/** Matches the start of a `plugins: [` array literal. */
const PLUGINS_ARRAY = /plugins\s*:\s*\[/;
/** Matches an ES import statement (used to place our import after the last one). */
const IMPORT_LINE = /^import\s.+from\s+['"][^'"]+['"];?\s*$/gm;

export const VitePatchKind = {
  APPLY: 'apply',
  ALREADY: 'already',
  MANUAL: 'manual',
} as const;
export type VitePatchKind = (typeof VitePatchKind)[keyof typeof VitePatchKind];

export type VitePatch =
  | { kind: typeof VitePatchKind.APPLY; code: string }
  | { kind: typeof VitePatchKind.ALREADY }
  | { kind: typeof VitePatchKind.MANUAL; reason: string };

const NO_PLUGINS_REASON = "couldn't find a `plugins: [...]` array to extend";

function insertImport(source: string): string {
  const matches = [...source.matchAll(IMPORT_LINE)];
  const last = matches[matches.length - 1];
  if (last?.index === undefined) {
    return `${VITE_IMPORT}\n${source}`;
  }
  const end = last.index + last[0].length;
  return `${source.slice(0, end)}\n${VITE_IMPORT}${source.slice(end)}`;
}

function insertPlugin(source: string): string {
  // Insert right after the opening `[` of the plugins array.
  return source.replace(PLUGINS_ARRAY, (match) => `${match}${IRIS_PLUGIN_CALL}, `);
}

export function patchViteConfig(source: string): VitePatch {
  if (source.includes(IRIS_MARKER)) {
    return { kind: VitePatchKind.ALREADY };
  }
  if (!PLUGINS_ARRAY.test(source)) {
    return { kind: VitePatchKind.MANUAL, reason: NO_PLUGINS_REASON };
  }
  return { kind: VitePatchKind.APPLY, code: insertImport(insertPlugin(source)) };
}
