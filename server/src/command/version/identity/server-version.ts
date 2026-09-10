import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

interface PackageJson {
  version: string;
  name: string;
}

/**
 * This package's own manifest, found by looking upwards rather than by counting directories.
 *
 * It used to say `../../package.json`, with a note explaining that two levels up was right from both
 * `src/version/` and `dist/version/`, and warning that moving the file meant editing the line by
 * hand because nothing would tell you. The file moved. Nothing told us: it is a runtime path, so the
 * compiler cannot see it, every test passed, and the failure appeared only when an app that embeds
 * the server tried to start.
 *
 * Walking up removes the question. The manifest is the first `package.json` above this file, which
 * is true from `src/`, from `dist/`, and from wherever either ends up next.
 */
function ownManifest(): PackageJson {
  let dir = dirname(new URL(import.meta.url).pathname);
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf8')) as PackageJson;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  // Loud rather than quiet. A missing manifest used to surface as an undefined version reported to
  // the agent and to telemetry, which reads as "this build has no version" rather than as a bug.
  throw new Error('cannot find the server package.json above ' + import.meta.url);
}

const _pkg: PackageJson = ownManifest();

/** The Reticle server version, read from package.json at startup. */
export const SERVER_VERSION: string = _pkg.version;

/**
 * The published npm package that carries the `reticle` bin — read from package.json so it can never
 * drift. Self-update installs THIS (never `@reticlehq/core`, which is schema-only and has no bin).
 */
export const RETICLE_NPM_PACKAGE: string = _pkg.name;
