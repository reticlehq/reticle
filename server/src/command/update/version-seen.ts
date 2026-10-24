/**
 * `version_changed` for every version move on a machine, not only a move through `reticle update`.
 *
 * Each CLI start compares its version with the last version that this machine ran, kept in
 * `~/.reticle/last-version`. A difference is one move. The file then holds the new version, so the
 * move is reported once. The first start on a machine records the version and reports nothing: an
 * install is not a move.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNewerVersion } from './update-nudge.js';

/** Which way the installed version moved. A rollback means a release hurt someone enough to retreat. */
export const VersionChangeDirection = {
  UPDATE: 'update',
  ROLLBACK: 'rollback',
} as const;
export type VersionChangeDirection =
  (typeof VersionChangeDirection)[keyof typeof VersionChangeDirection];

export interface VersionMove {
  readonly from: string;
  readonly to: string;
  readonly direction: VersionChangeDirection;
}

const LAST_VERSION_FILE = 'last-version';
/** Our own release numbers only. Anything else in the file is not sent. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?$/;
/** What a version that is not one of our release numbers reports as. */
export const OTHER_VERSION = 'other';

/**
 * A version string that came from outside this process, made safe to send: one of our release
 * numbers as it is, anything else as `other`, and nothing when there is no value.
 */
export function releaseVersionOf(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return RELEASE_VERSION.test(raw) ? raw : OTHER_VERSION;
}

/**
 * Record `current` as the last version this machine ran, and return the move when the record held
 * a different version. Never throws. A home that cannot be written reports no move, so a read-only
 * home does not send a move on every start.
 */
export function noteRunningVersion(current: string, stateDir: string): VersionMove | undefined {
  const file = join(stateDir, LAST_VERSION_FILE);
  let last: string | undefined;
  try {
    last = readFileSync(file, 'utf8').trim();
  } catch {
    last = undefined;
  }
  if (last === current) {
    return undefined;
  }
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, current, 'utf8');
  } catch {
    return undefined;
  }
  // ponytail: read-then-write is not atomic. Two first starts of a new version at the same moment
  // can both report the move. Use an exclusive claim file if the duplicates show in the data.
  if (last === undefined || !RELEASE_VERSION.test(last) || !RELEASE_VERSION.test(current)) {
    return undefined;
  }
  const direction = isNewerVersion(current, last)
    ? VersionChangeDirection.UPDATE
    : VersionChangeDirection.ROLLBACK;
  return { from: last, to: current, direction };
}
