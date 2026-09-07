/**
 * CRA (and other peer-conflicted npm repos) cannot install with a bare `npm i -D`.
 *
 * `init` used to run that command once, die on ERESOLVE, and skip every wiring step that depended
 * on the packages. The project's own `.npmrc` already named `--legacy-peer-deps`; so did every CI
 * buildspec. We can read that file, and we can retry once when npm refuses the first attempt.
 */
import { PackageManager } from './detect.js';

/** The flag npm understands. Named so a message can print it without inventing a spelling. */
export const LEGACY_PEER_DEPS_FLAG = '--legacy-peer-deps';

const ENABLED = /^\s*legacy-peer-deps\s*=\s*(true|1)\s*$/im;

/**
 * Does this project's `.npmrc` (or a parent's) already ask for the flag?
 *
 * Walked contents, not a live `npm config get`: init's planner is pure, and the file on disk is
 * the same signal CI and the project's own agent rules already follow.
 */
export function npmrcWantsLegacyPeerDeps(sources: readonly (string | null | undefined)[]): boolean {
  return sources.some((source) => 'string' === typeof source && ENABLED.test(source));
}

/** Append the flag unless it is already there. npm only — other managers reject the token. */
export function withLegacyPeerDeps(args: readonly string[]): string[] {
  return args.includes(LEGACY_PEER_DEPS_FLAG) ? [...args] : [...args, LEGACY_PEER_DEPS_FLAG];
}

/**
 * The second npm attempt when a bare install failed and the first command did not already pass
 * the flag. Undefined when retrying would be the same command, or not npm at all.
 */
export function npmLegacyPeerDepsRetry(exec: {
  command: string;
  args: readonly string[];
}): { command: string; args: string[] } | undefined {
  if (exec.command !== PackageManager.NPM) return undefined;
  if (exec.args.includes(LEGACY_PEER_DEPS_FLAG)) return undefined;
  return { command: exec.command, args: withLegacyPeerDeps(exec.args) };
}

export const LEGACY_PEER_DEPS_RETRY_NOTE =
  `the first npm install failed (often ERESOLVE on Create React App), so it was retried with ` +
  `${LEGACY_PEER_DEPS_FLAG} and that attempt succeeded. The project's own CI already uses this ` +
  `flag; a later \`npm i\` without it will hit the same conflict.`;
