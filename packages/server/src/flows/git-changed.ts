import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A git ref that cannot be used as a revision — leading `-` is an option, not a commit. */
export const GIT_REF_LOOKS_LIKE_OPTION =
  'git ref must name a revision, not a flag (refs starting with "-" are refused)';

/** Git did not produce a diff — bad ref, not a repo, or the binary failed. Not the same as "no files changed". */
export const GIT_DIFF_FAILED =
  'git diff failed — the change set is unknown (not an empty diff). Fix the ref or run from a git checkout.';

/**
 * True when `ref` is safe to pass to `git` as a revision operand.
 *
 * A string starting with `-` is parsed as an option (`--output=…`, `--abort`, …), which is how a
 * caller-controlled `--since` becomes arbitrary file write (CWE-88). Rejected before argv is built.
 */
export function isSafeGitRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-');
}

/** Parse `git diff --name-only` output into a clean file list. Pure; exported for testing. */
export function parseGitFiles(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Files changed since a git ref (`git diff --name-only <ref>`).
 *
 * Throws on an unsafe ref or any git failure. An empty array means exit 0 with no names — a real
 * empty diff — never "git could not run". Callers that used to treat `[]` as "nothing changed" were
 * false-greening the gate when the repo was missing or the ref was garbage.
 */
export async function changedFilesSince(ref: string, cwd: string): Promise<string[]> {
  if (!isSafeGitRef(ref)) {
    throw new Error(GIT_REF_LOOKS_LIKE_OPTION);
  }
  try {
    // `--end-of-options` (git ≥ 2.24): everything after is a revision/path, never an option — belt
    // beside `isSafeGitRef` for values that do not start with `-` but still confuse the parser.
    const { stdout } = await run('git', ['diff', '--name-only', '--end-of-options', '--', ref], {
      cwd,
    });
    return parseGitFiles(stdout);
  } catch (error) {
    if (error instanceof Error && error.message === GIT_REF_LOOKS_LIKE_OPTION) throw error;
    throw new Error(GIT_DIFF_FAILED, { cause: error });
  }
}
