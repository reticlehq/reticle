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
import { isTestFile } from './test-suffixes.mjs';

/**
 * Source files git knows about under a package's `src`, excluding tests.
 *
 * REFUSES rather than answering when the package holds an untracked source file, and that refusal
 * is the point of this comment.
 *
 * Every guard built on this enumerates through `git ls-files`, so a file nobody has staged
 * contributes NOTHING: no directory, no edges, no count. The guard then passes over a tree it never
 * read and reports success about it. That is not a hypothetical -- it happened twice in one day, to
 * two different people working in this repository:
 *
 *   - a new `cli/lifecycle/daemon-lifecycle.ts` was measured green before `git add`. The run saw
 *     the one edge INTO the new directory (from a tracked file that imported it) and none of the
 *     six edges out of it. The commit was red; a colleague found it.
 *   - the same shape, earlier, on a file added beside the artifact-root work.
 *
 * `flat-directories-are-recorded` already said "A new file is invisible here until it is STAGED" --
 * but only in its FAILURE message, which is exactly the path you do not reach when the file is
 * invisible. Saying it here makes it true for every consumer of this function, which is what the
 * repository's own rule about fixing the one shared thing rather than watching its callers asks for.
 *
 * Throwing, rather than quietly including untracked files, because "stage it and run again" is a
 * two-second instruction and the alternative silently changes what every guard is measuring.
 */
export function sourceFiles(packageDir) {
  const unstaged = execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'src'], {
    cwd: packageDir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !isTestFile(f));
  if (0 < unstaged.length) {
    throw new Error(
      `this check reads what git TRACKS, and ${packageDir} holds ${String(unstaged.length)} ` +
        `unstaged source file(s) it cannot see:\n  ${unstaged.join('\n  ')}\n` +
        'Stage them and run it again — a pass over a file nobody staged is a pass over a tree ' +
        'this never read.',
    );
  }
  return execFileSync('git', ['ls-files', 'src'], { cwd: packageDir, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !isTestFile(f));
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
    /*
     * `@/x` as well as `./x` and `../x`.
     *
     * `@/` means "this package's src", resolved at compile time by tsconfig `paths` and rewritten
     * back to a relative path at build time. This graph is built from SOURCE, so it sees the alias
     * and has to resolve it — a matcher that recognised only relative specifiers would report an
     * ever-shrinking graph as the codebase adopted the alias, and report it as the coupling going
     * DOWN. A guard that goes quiet while its subject changes underneath it is the failure this
     * repository keeps paying for.
     */
    for (const match of text.matchAll(/from '((?:\.\.\/|\.\/|@\/)[^']+)'/g)) {
      const spec = match[1] ?? '';
      const target = spec.startsWith('@/')
        ? posix.normalize(posix.join('src', spec.slice(2)))
        : posix.normalize(posix.join(fromDir, spec));
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
