/**
 * Types for the part of the dependency-boundary guard that other checks reuse.
 *
 * The guard itself is plain JavaScript so it can run with `node` and no build step. TypeScript
 * cannot read types out of that, so the shapes are written here. Only what is actually shared is
 * declared: if this drifts from the real file, the very next use of it stops compiling, which is the
 * loud failure rather than the quiet one.
 */

/** The package globs listed in `pnpm-workspace.yaml`, in the order they appear. */
export function workspaceGlobs(yamlText: string): string[];
