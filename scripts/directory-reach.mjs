// Which directory reaches for which, inside one package.
//
// Extracted because there are now three callers and there was one implementation: the server's
// guard, the browser's guard, and `safe-to-group.mjs`, which predicts what those guards will say.
// Three copies of a graph computation is three chances for the prediction to disagree with the
// test it is predicting, which would be worse than having no prediction.
//
// TWO PROPERTIES ARE LOAD-BEARING AND EASY TO LOSE.
//
// Tests are excluded. A test importing across a boundary is not the package depending on it, and
// counting them would make every directory reach for every other within a week.
//
// A directory is identified by its BASENAME. That keeps a reach list readable -- `tools -> session`
// rather than two full paths per line -- and it means two directories that share a name are ONE
// node here, with their reaches merged and any mutual pair between them unreportable. That is not
// a hypothetical: it happened, every reach test still passed, and the only symptom was a new
// directory that appeared to have no reaches at all. Callers must pair this with the uniqueness
// check below, which is why it ships in the same file.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Source files git knows about under a package's `src`, excluding tests. */
export function sourceFiles(packageDir) {
  return execFileSync('git', ['ls-files', 'src'], { cwd: packageDir, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
}

/** Every directory under `src` holding a source file, as package-relative posix paths. */
export function directories(packageDir) {
  const dirs = sourceFiles(packageDir).map((f) => posix.dirname(f));
  return [...new Set(dirs)].filter((d) => 'src' !== d);
}

/**
 * Directories sharing a basename, as `name: pathA and pathB`.
 *
 * Empty is the only acceptable answer. See the note at the top: a collision makes the graph below
 * quietly wrong while every assertion over it still passes.
 */
export function nameCollisions(packageDir) {
  const seen = new Map();
  for (const dir of directories(packageDir)) {
    const name = posix.basename(dir);
    seen.set(name, [...(seen.get(name) ?? []), dir]);
  }
  return [...seen.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => `${name}: ${paths.join(' and ')}`);
}

/** `directory -> the directories it imports from`, by basename, within this package only. */
export function reaches(packageDir) {
  const found = new Map();
  for (const file of sourceFiles(packageDir)) {
    const fromDir = posix.dirname(file);
    if ('src' === fromDir) continue; // a file with no directory of its own has no neighbours
    const own = posix.basename(fromDir);
    const text = readFileSync(join(packageDir, file), 'utf8');
    for (const match of text.matchAll(/from '((?:\.\.\/|\.\/)[^']+)'/g)) {
      const target = posix.normalize(posix.join(fromDir, match[1] ?? ''));
      if (!target.startsWith('src/')) continue; // left the package: not this check's business
      const other = posix.basename(posix.dirname(target));
      if ('' === other || other === own || 'src' === other) continue;
      found.set(own, (found.get(own) ?? new Set()).add(other));
    }
  }
  return found;
}

/** Pairs where each reaches for the other, as `a <-> b`, each named once and sorted. */
export function mutualPairs(packageDir) {
  const graph = reaches(packageDir);
  const pairs = new Set();
  for (const [from, targets] of graph) {
    for (const to of targets) {
      if (graph.get(to)?.has(from) === true) pairs.add([from, to].sort().join(' <-> '));
    }
  }
  return [...pairs].sort();
}
