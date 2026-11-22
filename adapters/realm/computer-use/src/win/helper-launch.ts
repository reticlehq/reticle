/**
 * How to start the helper on each operating system. macOS runs `reticle-ax`, built from Swift.
 * Windows runs `reticle-uia.ps1` in PowerShell, which reads UI Automation and answers in the same
 * shape, so the same driver (`MacDriver`) and the same reader work on both.
 */
import { join } from 'node:path';

export interface HelperLaunch {
  /** The program to start. */
  file: string;
  /** The words before the command: the script, for PowerShell. */
  prefix: readonly string[];
}

export const WINDOWS_HELPER_SCRIPT = 'reticle-uia.ps1';
const POWERSHELL = 'powershell.exe';

/** The helper for `platform` (a value of `process.platform`), or undefined when there is none. */
export function helperLaunch(platform: string, nativeDir: string): HelperLaunch | undefined {
  if ('darwin' === platform) {
    return { file: join(nativeDir, 'mac', 'build', 'reticle-ax'), prefix: [] };
  }
  if ('win32' === platform) {
    return {
      file: POWERSHELL,
      prefix: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(nativeDir, 'win', WINDOWS_HELPER_SCRIPT),
      ],
    };
  }
  return undefined;
}
