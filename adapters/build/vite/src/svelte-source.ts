import { createRequire } from 'node:module';
import { relative } from 'node:path';
import { DATA_RETICLE_SOURCE_ATTR } from '@reticlehq/core';

/**
 * `data-reticle-source` for `.svelte` single-file components.
 *
 * A SvelteKit app onboards, connects, and gets DOM, network, console, routing and storage — and then
 * every verdict comes back without the `file:line` the whole product leads with, because the JSX
 * stamper is Babel and a `.svelte` file is not JavaScript. This is the Svelte half.
 *
 * ## Where in the pipeline
 *
 * A Vite `transform` on the RAW component source, in the Reticle plugin, which already declares
 * `enforce: 'pre'` — so it runs before `@sveltejs/vite-plugin-svelte` and hands the compiler markup
 * that already carries the attribute. Getting the order wrong is the failure mode worth naming: run
 * it after, and there is no markup left to stamp, only generated JavaScript whose original line
 * numbers are gone. A Svelte *preprocessor* would also work and would be equally correct, but it has
 * to be wired into `svelte.config.js` by the user, and an integration nobody enables is an
 * integration that does not exist.
 *
 * ## Why the compiler is loaded the way it is
 *
 * `svelte` must never become a dependency of this package: a React project installing the Vite
 * plugin must not acquire a Svelte compiler, and its build must be unaffected. So the compiler is
 * resolved lazily, from the APP's directory, only when a `.svelte` id actually arrives, and its
 * absence returns null rather than throwing. Same shape as the optional `playwright` import in the
 * server's pool launcher.
 *
 * Resolution is synchronous (`createRequire`) rather than `await import()` because Svelte ships a CJS
 * build of its compiler and the plugin's `transform` is synchronous — making the whole hook async to
 * fetch an optional dependency would change the contract of every other path through it.
 *
 * ## Scope
 *
 * The attribute only. Mapping a DOM node to the COMPONENT that rendered it — what `@reticlehq/react`
 * does through the fiber tree — is a separate and much larger problem, and is not attempted here.
 */

/** Files this module stamps. `.svelte.ts` (a runes module) is code, not markup — excluded. */
export const SVELTE_FILE = /\.svelte$/;

/** Element node types that are a real place in the DOM, in Svelte 5's AST and Svelte 4's. */
const HOST_ELEMENT_TYPES: ReadonlySet<string> = new Set(['RegularElement', 'Element']);

/** The `parent` back-reference some AST shapes carry; following it would walk forever. */
const PARENT_KEY = 'parent';

/** The part of `svelte/compiler` this module uses. Structural, so `svelte` stays un-imported. */
interface SvelteCompilerLike {
  parse: (source: string, options?: { modern?: boolean }) => unknown;
}

/** How the compiler is obtained. Injected in tests; the default resolves it from the app. */
type LoadSvelteCompiler = () => SvelteCompilerLike | null;

/** Resolved once per process: `null` means "looked, not installed" and must not be retried per file. */
let cachedCompiler: SvelteCompilerLike | null | undefined;

function defaultLoadCompiler(): SvelteCompilerLike | null {
  if (cachedCompiler !== undefined) return cachedCompiler;
  cachedCompiler = null;
  // From the APP's root first. The plugin may be linked, hoisted, or in a pnpm store far from the
  // project, and the compiler that matters is the one the app's own Svelte plugin will use.
  //
  // `import.meta.url` is this module's own location and is the ESM spelling of it. The package also
  // ships a CJS build (an app without `"type": "module"` can only `require` its Vite config), where
  // `import.meta` is empty — so that build SUBSTITUTES `__filename` here rather than leaving the
  // expression to evaluate to nothing. Both artefacts therefore try the same two origins; see
  // scripts/build-cjs.mjs. Reading it unguarded is deliberate: the build fails loudly if the
  // substitution is ever dropped.
  for (const from of [`${process.cwd()}/package.json`, import.meta.url]) {
    try {
      cachedCompiler = createRequire(from)('svelte/compiler') as SvelteCompilerLike;
      break;
    } catch {
      // Not resolvable from here — try the next origin, then give up silently.
    }
  }
  return cachedCompiler;
}

/**
 * A character offset as Babel would report it: 1-based line, 0-based column.
 *
 * Matching Babel exactly is not cosmetic — `parseSourceAttr` in the browser SDK reads one format,
 * and a Svelte pointer that was 0-based on line would land every verdict one line off while looking
 * completely plausible.
 */
export function offsetToLineColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if ('\n' === source[i]) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

/** Project-relative, forward-slashed. A pointer must be the same string on Windows as on Linux. */
function sourcePathFor(id: string, cwd: string = process.cwd()): string {
  return relative(cwd, id).replace(/\\/g, '/');
}

interface ElementNode {
  type: string;
  name: string;
  start: number;
  attributes?: unknown[];
}

function isElementNode(value: unknown): value is ElementNode {
  if (null === value || typeof value !== 'object') return false;
  const node = value as Partial<ElementNode>;
  return (
    'string' === typeof node.type &&
    HOST_ELEMENT_TYPES.has(node.type) &&
    'string' === typeof node.name &&
    'number' === typeof node.start
  );
}

function isAlreadyStamped(node: ElementNode): boolean {
  return (node.attributes ?? []).some(
    (attr) =>
      attr !== null &&
      'object' === typeof attr &&
      (attr as { name?: unknown }).name === DATA_RETICLE_SOURCE_ATTR,
  );
}

/**
 * Collect every host element in the AST.
 *
 * A GENERIC walk over the object graph rather than a switch over Svelte's block types. `{#if}`,
 * `{#each}`, `{#await}`, `{#key}`, `{#snippet}` and whatever the next release adds each nest their
 * children under a differently-named field, and a hand-written descent silently misses the ones it
 * has not heard of — elements inside an `{#each}` would simply never be stamped, with nothing to
 * indicate they were skipped.
 */
function collectElements(root: unknown): ElementNode[] {
  const found: ElementNode[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (null === value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isElementNode(value) && !isAlreadyStamped(value)) found.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (key !== PARENT_KEY) visit(child);
    }
  };
  visit(root);
  return found;
}

/**
 * Stamp `data-reticle-source="file:line:column"` on every host element of a `.svelte` component.
 *
 * Returns null — never throws — when the compiler is absent or the component does not parse. In dev
 * the transform runs on every keystroke, so a half-typed component is the NORMAL case; failing the
 * build over one would make Reticle the reason the dev server is red, for a feature that is pure
 * enrichment on top of an app that otherwise works.
 */
export function stampSvelte(
  code: string,
  id: string,
  load: LoadSvelteCompiler = defaultLoadCompiler,
): string | null {
  const compiler = load();
  if (null === compiler) return null;
  let ast: unknown;
  try {
    // `modern: true` selects Svelte 5's AST; Svelte 4 ignores the option and returns its own shape.
    // `collectElements` accepts both, so one call covers either major without a version probe.
    ast = compiler.parse(code, { modern: true });
  } catch {
    return null;
  }
  const elements = collectElements(ast);
  if (0 === elements.length) return null;
  const file = sourcePathFor(id);
  // Insert from the LAST element backwards: every insertion shifts the offsets after it, and
  // applying them in source order would put each stamp progressively further from its own tag.
  const ordered = [...elements].sort((a, b) => b.start - a.start);
  let out = code;
  for (const node of ordered) {
    const { line, column } = offsetToLineColumn(code, node.start);
    const insertAt = node.start + 1 + node.name.length;
    const attribute = ` ${DATA_RETICLE_SOURCE_ATTR}="${file}:${String(line)}:${String(column)}"`;
    out = `${out.slice(0, insertAt)}${attribute}${out.slice(insertAt)}`;
  }
  return out;
}
