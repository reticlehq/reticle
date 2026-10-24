import { ReticleEnv } from '../wire/constants/reticle-env.js';

/** Why a state or token folder was refused. Names the variables that move it. */
export const stateDirNotAbsolute = (dir: string): string =>
  `The Reticle state folder "${dir}" is not an absolute path, so Reticle did not use it. A ` +
  'relative folder is made inside the folder this process runs in, which is often the project. ' +
  `Set ${ReticleEnv.PAIRING_TOKEN_DIR} and ${ReticleEnv.STATE_DIR} to absolute paths, or unset them.`;

/** Why a relative override was used against the working folder. */
export const stateDirResolvedFromCwd = (dir: string, resolved: string): string =>
  `The Reticle state folder "${dir}" is a relative path. Reticle uses "${resolved}", in the folder ` +
  `this process runs in. Set ${ReticleEnv.PAIRING_TOKEN_DIR} to an absolute path to remove this warning.`;

/** Why a Windows drive path was not used on a POSIX system. */
export const stateDirWindowsPathOnPosix = (dir: string, fallback: string): string =>
  `The Reticle state folder "${dir}" is a Windows path, and this system does not use Windows paths. ` +
  `Reticle did not use it, and uses "${fallback}". Set ${ReticleEnv.PAIRING_TOKEN_DIR} to a path ` +
  'for this system, or unset it.';

/** A Windows drive path: `C:\...`, `C:/...` or the drive-relative `C:x`. */
const WINDOWS_DRIVE = /^[A-Za-z]:/;
/** The separator of POSIX path rules. */
const POSIX_SEPARATOR = '/';

/** The `node:path` rules the caller uses. Core imports no Node module, so the caller passes them. */
export interface StatePathRules {
  isAbsolute: (path: string) => boolean;
  resolve: (path: string) => string;
  sep: string;
}

/**
 * The folder for the pairing token or other machine state: the override when it is set, else the
 * fallback. A setting that cannot be used never stops Reticle. It gets one warning and a folder:
 *
 * - A relative override is resolved against the working folder, as Reticle did up to 3.7.
 * - A Windows drive path on POSIX (WSL, a container) is not used. Such a path is relative there, and
 *   it made a `C:` folder inside the app, with the pairing token under it. The fallback is used.
 *
 * Throws only when the fallback is not absolute, because then no folder is safe to use.
 */
export function resolveStateDir(
  override: string | undefined,
  fallback: string,
  rules: StatePathRules,
  warn: (message: string) => void,
): string {
  if (override !== undefined && override.length > 0) {
    if (rules.isAbsolute(override)) {
      return override;
    }
    if (rules.sep !== POSIX_SEPARATOR || !WINDOWS_DRIVE.test(override)) {
      const resolved = rules.resolve(override);
      warn(stateDirResolvedFromCwd(override, resolved));
      return resolved;
    }
    warn(stateDirWindowsPathOnPosix(override, fallback));
  }
  if (!rules.isAbsolute(fallback)) {
    throw new Error(stateDirNotAbsolute(fallback));
  }
  return fallback;
}
