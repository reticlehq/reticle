/**
 * Detecting whether a project uses Prettier.
 *
 * Lives in `detect/` (not `patch/`) because `patch/` already imports from `detect/` —
 * the reverse import would create a `detect <-> patch` cycle that
 * `directory-reach.test.ts` forbids. Detection belongs here anyway.
 */

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  prettier?: unknown;
}

/** Filenames that indicate the project uses Prettier. */
export const PRETTIER_CONFIG_FILES = new Set([
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.json5',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
]);

/**
 * True when the project uses Prettier: a Prettier config file exists at the root,
 * package.json declares a "prettier" key, or prettier is in (dev)dependencies.
 */
export function hasPrettierConfig(rootFiles: ReadonlySet<string>, pkg: PackageJsonLike): boolean {
  for (const name of rootFiles) {
    if (PRETTIER_CONFIG_FILES.has(name)) return true;
  }
  if (pkg.prettier !== undefined) return true;
  return (
    pkg.dependencies?.prettier !== undefined ||
    pkg.devDependencies?.prettier !== undefined ||
    pkg.peerDependencies?.prettier !== undefined
  );
}
