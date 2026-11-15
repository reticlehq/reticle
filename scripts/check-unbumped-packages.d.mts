/**
 * Types for the part of the unbumped-package check that a guard test reuses.
 *
 * The check itself is plain JavaScript so it can run with `node` and no build step. Only what is
 * shared is declared: if this drifts from the real file, the next use of it stops compiling.
 */

/**
 * The differences between two unpacked packages: the one npm serves and the one this tree packs.
 * Each line names a file and says how it differs. `package.json` is read as data.
 */
export function contentDifferences(npmDir: string, localDir: string): string[];
