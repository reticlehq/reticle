import { createRequire } from 'node:module';

interface PackageJson {
  version: string;
  name: string;
}

// NOTE: a RUNTIME path, not an import — `tsc` does not check it and a file move will not rewrite
// it. Two levels up because this file sits in `version/`: from `src/version/` and from
// `dist/version/` alike, `../../package.json` is the package manifest. Moving this file again means
// changing this line by hand; nothing else will tell you.
const _pkg: PackageJson = createRequire(import.meta.url)('../../package.json') as PackageJson;

/** The Reticle server version, read from package.json at startup. */
export const SERVER_VERSION: string = _pkg.version;

/**
 * The published npm package that carries the `reticle` bin — read from package.json so it can never
 * drift. Self-update installs THIS (never `@reticlehq/core`, which is schema-only and has no bin).
 */
export const RETICLE_NPM_PACKAGE: string = _pkg.name;
