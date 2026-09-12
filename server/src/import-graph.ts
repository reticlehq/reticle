/**
 * Walk this package's own import graph.
 *
 * Used by the boundary guards. Both of them ask the same question in different words: "starting from
 * this entry file, which modules can actually be reached?" — and both need the real graph rather than
 * a grep, because the reach that matters is the transitive one. Nobody writes a forbidden import in
 * `index.ts`; they write it four modules down, in something `index.ts` happens to pull in.
 *
 * Deliberately simple. It reads text and matches import specifiers rather than parsing TypeScript,
 * because a guard nobody can read is a guard nobody maintains. That means it sees a specifier inside
 * a string literal or a comment too. For a guard that is the safe direction to be wrong in: it can
 * report a crossing that is not real (someone looks, and says so), never miss one that is.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

/**
 * Turn an import specifier into a path relative to the source root.
 *
 * Returns undefined for bare package names like `zod` — those are somebody else's code, and this
 * walker only cares about modules inside this package.
 *
 * Imports here are always written with a `.js` extension even though the file on disk is `.ts`
 * (that is how Node resolves ES modules after they are compiled), so the extension is swapped back.
 */
export function resolveImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return normalize(join(dirname(fromFile), specifier))
    .split(sep)
    .join('/')
    .replace(/\.js$/, '.ts');
}

/**
 * Every import specifier written in one file, in the order they appear.
 *
 * Covers static imports, type-only imports, re-exports (`export ... from`) and dynamic `import(...)`.
 * A file that cannot be read yields nothing rather than throwing — a stale path in a list should not
 * take the whole guard down with it.
 */
export function importsOf(sourceRoot: string, file: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(sourceRoot, file), 'utf8');
  } catch {
    return [];
  }
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * Every module reachable from `entry`, breadth-first.
 *
 * The returned map is `module -> the module that first reached it`, so a guard can report the EDGE
 * that broke the rule ("cli.ts imported it") rather than just the file. When a boundary breaks, the
 * useful question is always "who pulled this in", and the answer is otherwise a manual search.
 */
export function reachableFrom(sourceRoot: string, entry: string): Map<string, string> {
  const reachedVia = new Map<string, string>([[entry, entry]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) continue;
    for (const specifier of importsOf(sourceRoot, file)) {
      const target = resolveImport(file, specifier);
      if (target === undefined || reachedVia.has(target)) continue;
      reachedVia.set(target, file);
      queue.push(target);
    }
  }
  return reachedVia;
}
