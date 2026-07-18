import { createRequire } from 'node:module';

interface PackageJson {
  version: string;
  name: string;
}

const _pkg: PackageJson = createRequire(import.meta.url)('../package.json') as PackageJson;

/** The Reticle server version, read from package.json at startup. */
export const SERVER_VERSION: string = _pkg.version;

/**
 * The published npm package that carries the `reticle` bin — read from package.json so it can never
 * drift. Self-update installs THIS (never `@reticlehq/core`, which is schema-only and has no bin).
 */
export const RETICLE_NPM_PACKAGE: string = _pkg.name;
