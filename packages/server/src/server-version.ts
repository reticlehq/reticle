import { createRequire } from 'node:module';

interface PackageJson {
  version: string;
}

const _pkg: PackageJson = createRequire(import.meta.url)('../package.json') as PackageJson;

/** The Reticle server version, read from package.json at startup. */
export const SERVER_VERSION: string = _pkg.version;
