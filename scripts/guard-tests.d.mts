/**
 * Types for the part of the guard/unit splitter that other checks reuse.
 *
 * Same arrangement as `check-boundaries.d.mts`: the splitter is plain JavaScript so it can run
 * with `node` and no build step, TypeScript cannot read types out of that, and only what is
 * actually shared is declared. If this drifts from the real file, the next use stops compiling,
 * which is the loud failure rather than the quiet one.
 */

/** Does this test file build a path that leaves its own package? */
export function escapesPackage(file: string): boolean;

/**
 * The repo-reading half of a package's suite, as paths relative to the package root and always
 * with forward slashes, because these become vitest arguments.
 */
export function guardTests(packageDir: string): string[];
