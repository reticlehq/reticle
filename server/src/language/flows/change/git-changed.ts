import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Parse `git diff --name-only` output into a clean file list. Pure; exported for testing. */
export function parseGitFiles(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The outcome of asking git what changed — files, and whether the question could be answered.
 *
 * `files: []` used to mean both "the tree is clean" and "git could not tell us", and those are
 * opposite answers to the only question `reticle_affected` and `reticle_verify_change` exist to ask.
 * A caller that cannot distinguish them reports "nothing to re-verify" over a mistyped ref, a
 * shallow clone with no history, or a daemon outside the repository — and the agent ships.
 */
export interface ChangedFiles {
  files: string[];
  /** True when git could not answer. `files` is then empty because nothing was learned. */
  failed: boolean;
  /** Why, when it failed — for the caller to surface, never to swallow. */
  reason?: string;
}

/**
 * A ref beginning with `-` is read by git as an OPTION, not a ref.
 *
 * `execFile` runs no shell, so this is argument injection rather than command injection — but
 * `--output=<path>` in the ref position is enough to make git write somewhere it was not asked to.
 * Refused rather than escaped: `--end-of-options` is not supported by every git version we might
 * meet, and a ref that starts with a dash is not a thing a caller legitimately wants.
 */
function refIsOptionLike(ref: string): boolean {
  return ref.startsWith('-');
}

/**
 * Files changed since a git ref (`git diff --name-only <ref>`), so `reticle gate --since main` works
 * from the real diff instead of hand-listed files.
 *
 * Never throws, and never pretends. The CLI gate may still degrade to "no changes" and pass rather
 * than crash CI — that reasoning was right and is unchanged — but it now has to opt into doing so by
 * ignoring `failed`, instead of being handed a clean-looking empty list. The MCP tools read the flag
 * and say they could not tell.
 */
export async function changedFilesSince(ref: string, cwd: string): Promise<ChangedFiles> {
  if (refIsOptionLike(ref)) {
    return {
      files: [],
      failed: true,
      reason: `refusing ref "${ref}": a leading dash makes git read it as an option, not a ref`,
    };
  }
  try {
    const { stdout } = await run('git', ['diff', '--name-only', ref], { cwd });
    return { files: parseGitFiles(stdout), failed: false };
  } catch (error) {
    return {
      files: [],
      failed: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
