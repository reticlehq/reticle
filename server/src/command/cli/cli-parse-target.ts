/**
 * The change-target grammar `reticle affected` and `reticle gate` share: `[--since <ref>] [file...]`,
 * and what an empty target means.
 *
 * Split out of `cli-parse.ts` when that file crossed the line cap. Cohesive on its own terms: it is the
 * one part of the grammar that answers "which change is this about", and both commands read it the
 * same way.
 */
const SINCE_FLAG = '--since';

/**
 * What `reticle gate` / `reticle affected` mean with NOTHING after them: the working tree.
 *
 * They used to mean a usage error — while the rule `reticle init` writes into the agent's own
 * instruction file says, in as many words, "run `reticle gate`". An instruction the tool rejects is
 * worse than no instruction: the agent spends a turn on it and concludes Reticle is broken.
 *
 * HEAD is the ref that answers the question being asked. Explicit files or an explicit --since still
 * win; this only fills the empty case.
 */
const WORKING_TREE_REF = 'HEAD';

export function implicitSince(files: readonly string[]): string | undefined {
  return 0 === files.length ? WORKING_TREE_REF : undefined;
}

/** Parse `[--since <ref>] [file...]` shared by `affected` and `gate`. */
export function parseTargetArgs(rest: string[]): { files: string[]; since?: string } {
  const files: string[] = [];
  let since: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === SINCE_FLAG) {
      since = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg !== undefined && !arg.startsWith('-')) files.push(arg);
  }
  return since === undefined ? { files } : { files, since };
}
