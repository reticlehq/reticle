import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * Why a guard that reads `git ls-files` can disagree with the editor in front of you.
 *
 * It cost a blocked commit and a wrong diagnosis: `verify` passed on an untracked new file,
 * `git add` made it tracked, and the identical test then failed in the hook. I blamed turbo's
 * cache, started widening its inputs, and measured three cases that all invalidated correctly
 * before noticing the real cause. The message says it now so nobody repeats that.
 */
const STAGED_NOTE =
  'A new file is invisible here until it is STAGED: this counts what git tracks, so `pnpm verify` before `git add` and the pre-commit hook after it are asking about two different trees. If you just created or deleted one, stage it and run this again.\n\n';

/**
 * How many source files sit loose in one directory, recorded so it cannot creep.
 *
 * A directory with forty files in it is not a design; it is what happens when nobody was
 * counting. This sweep took `surface/tools` from 160 to 32, `features/flows` from 35 to 24 and
 * `command/daemon` from 15 to 7, one verified extraction at a time — and every one of those
 * numbers can drift straight back, one file per commit, with no gate anywhere noticing.
 *
 * Nothing else here measures this. The reach guards count DIRECTORIES and the pairs between
 * them, which says how tangled the package is and nothing at all about how much is piled inside
 * any one of them. A file added flat to a big directory changes no reach, breaks no pair, and
 * is invisible to every check in the repository.
 *
 * So the over-ten directories are listed with their counts, by equality. Growing one is not
 * forbidden — it is a thing to do deliberately, in a commit that says the number went up and
 * why. Shrinking one is the work this list exists to protect, and lowering the number in the
 * same commit is what locks the gain in, exactly as the mutual-pair counts do.
 *
 * Test files are excluded, as everywhere else in this family of guards, because a directory
 * with ten sources and ten tests beside them is not the problem being described.
 */

/** The line the sweep was run against. Ten is the user's number, not a derived one. */
const FLAT_FILE_LIMIT = 10;

/**
 * Measured 2026-09-11, at the end of a sweep of twenty-seven verified extractions.
 *
 * Three entries will not come down by the rule that produced the rest, and say so here rather
 * than looking like neglect:
 *
 *   server/src/telemetry            another agent owns these files; not mine to move.
 *   engine/src/question/predicate   a wildcard export subpath. The FILENAMES are published API
 *   engine/src/evidence             and moving one is a breaking change — see
 *                                   public-subpaths-are-pinned.test.ts.
 */
const OVER_THE_LINE: Readonly<Record<string, number>> = {
  'adapters/build/vite/src': 11,
  'adapters/realm/dom/src/dom': 12,
  'adapters/realm/dom/src/observers': 23,
  // 17 since the HUD's position primitives left `presenter-drag.ts` for their own leaf: the drag
  // gesture re-syncs the dock layout, and the dock layout reads the HUD's position, so the two files
  // needed each other over primitives that belong to neither.
  'adapters/realm/dom/src/presenter': 17,
  'core/src/verdict': 11,
  'core/src/wire': 15,
  // 15 since the shared step-effect builder. Recorded rather than grouped: the note above explains
  // why this directory cannot come down by the usual rule — its FILENAMES are published API, so
  // moving one to tidy the count would be a breaking change for somebody outside this repository.
  /*
   * Crossed ten when `flow-step-tool.ts` was split out of `flow-types.ts`. Recorded rather than
   * grouped: the split is the POINT — those constants are imported by the browser SDK, and living
   * beside eleven zod schemas meant every page Reticle instruments loaded schemas it can never use.
   *
   * 13 since the replay language grew the two things a flow must say about ITSELF rather than about
   * a step: `step-effect.ts` (read / idempotent / commits) and `flow-composition.ts` (`canFollow`).
   * Both are LEAVES on purpose. `step-effect.ts` was born inside `flow-types.ts` and the SDK's
   * first-load guard caught it immediately: every instrumented page was paying for a constant it
   * can never use, because importing it dragged in eleven zod schemas. Moving it here bought back
   * exactly one byte, which is how we learned the cost was the schema and not the constant -- but a
   * leaf the browser can import without the schemas is still the right shape, and the guard's
   * ceiling was raised with that reasoning written beside it.
   */
  'core/src/artifacts': 13,
  'engine/src/evidence': 17,
  // 18 since the last two cycles in this package were removed: `predicate-eval-kit.ts` (the result
  // type and the four comparisons the oracles are written in) and `predicate-session.ts` (what the
  // engine needs from a session). Both were reached back out of the modules that call their readers.
  'engine/src/question/predicate': 18,
  /*
   * Crossed ten when the fast-drive budget and a portable byte counter landed. The guard asks for
   * grouping rather than recording at this moment, and grouping is the wrong move HERE specifically:
   * `./window/*.js` is a published glob subpath, so every filename in this directory is an import
   * path somebody outside this repository may already have written, and moving one is a breaking
   * change dressed as tidying. Recorded on purpose; the grouping belongs in the same change that
   * revisits engine's public subpaths, not in a feature commit.
   */
  'engine/src/window': 11,
  'init/src/patch': 14,
  // Crossed the line as the protocol grew the two things a subject must declare about ITSELF rather
  // than about what it can see: how it may be driven, and the state a suite starts from. Recorded
  // rather than grouped -- this directory IS the vocabulary, and splitting it would put nouns an
  // implementer reads together into two places.
  'open-verification/src/vocabulary': 12,
  // 12 since `defaultRunId` moved out of `runner-port.ts` into its own leaf: `verification-sync`
  // wanted that one function and imported a module that pulls the whole flow-replay stack, closing a
  // cycle. Same trade as `language/flows` below — a cycle is paid for in files.
  'server/src/judgement/runs': 12,
  // 33 since `act-merged.ts`: `reticle_act` absorbing `reticle_act_sequence`, routed on the shape of
  // the call rather than on an `action` name because `act` already owns that parameter. It is its
  // own file rather than a branch inside `merge-tools.ts` for exactly that reason — it is the one
  // merge the plan machinery cannot express, and burying it there would hide why.
  'server/src/surface/tools': 33,
  // Crossed the line when a planned step gained its own `expect`: the grading rule and its test
  // joined the act cluster (preflight, target, retry, capsule). Recorded rather than grouped,
  // because this directory IS the grouping -- these files were split out of act-tools.ts when it
  // hit the line cap, and splitting them again would scatter one cohesive unit across two homes.
  'server/src/surface/tools/act': 11,
  // 19 since `setup-mcp-cli.ts`: the terminal half of `reticle setup mcp`, which the one-line
  // installer runs before any project exists. It sits HERE and not in `setup/` because the reach
  // guard refused `command -> setup` and CLI handlers already live in this directory.
  'server/src/command/cli': 19, // + tutorial.ts: one sequence, two audiences, ending at a verdict
  // 17 since the installer's Node half: `setup-mcp.ts` (which agents are here, and merging into the
  // configs they already keep) and `setup-install.ts` (the three steps only the shell could time).
  // Both are pure — their telemetry reporter is INJECTED, because this directory does not own a
  // telemetry client and the reach guard was right to say so.
  'server/src/command/setup': 17,
  'server/src/portal/session': 20,
  // 32 since two leaves were extracted out of `flow-replay.ts` to break the last runtime cycle in
  // this directory: `flow-replay-types.ts` (shapes two collaborators share) and `flow-anchor.ts`
  // (resolving a step's anchor). Breaking a cycle costs files — a module that sits UNDER two others
  // cannot also be one of them. Raised deliberately, and the grouping this directory still wants is
  // a `replay/` subdirectory for the nine files that cluster there, which is its own commit.
  'server/src/language/flows': 32,
  // 12 since `drive-flow.ts`: the rule that turns a session's ambient tape into a flow per journey,
  // and the gate that refuses to save one asserting nothing. It sits beside `session-end.ts` because
  // teardown is the only caller and the tape is data by then — the reach guard already refused the
  // alternative, which was for this file to live near the recorder and pull teardown into it.
  'server/src/memory/journal': 12,
  // 35 since the setup funnel: `onboarding-funnel.ts` (the one emit chokepoint), `onboarding-firsts.ts`
  // (the first look / act / verdict of a run, which only the daemon can witness) and
  // `install-trace.ts` (draining what the installer could not report, because it ran before there
  // was a CLI). Three files rather than one: they answer at three different moments.
  'server/src/telemetry': 35,
  'spec-runner/src': 11,
};

/** Tracked, shipped, non-test TypeScript, grouped by the directory it sits in. */
function flatCounts(): Map<string, number> {
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((path) => '' !== path);
  const counts = new Map<string, number>();
  for (const path of tracked) {
    // apps/ are local fixtures, plan/ is gitignored design notes, bench/ is the harness.
    if (/^(apps|plan|bench)\//.test(path)) continue;
    if (/\.(test|spec|bench)\.tsx?$/.test(path)) continue;
    const dir = dirname(path);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

describe('how much sits loose in one directory', () => {
  it('finds source files at all, so a pass is not a pass over nothing', () => {
    // A listing that silently stopped resolving would report no directories over the line, and
    // the whole check would read as a clean bill of health.
    const counts = flatCounts();
    expect(counts.size).toBeGreaterThan(50);
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBeGreaterThan(500);
  });

  it(`records every directory holding more than ${String(FLAT_FILE_LIMIT)} source files`, () => {
    const found: Record<string, number> = {};
    for (const [dir, count] of [...flatCounts()].sort()) {
      if (count > FLAT_FILE_LIMIT) found[dir] = count;
    }
    expect(
      found,
      STAGED_NOTE +
        'the flat-file counts moved. A directory that grew: add the file somewhere it belongs, or ' +
        'raise the number here on purpose. A directory that shrank, or left the list: lower or ' +
        'remove it in the same commit, so the next person does not pay for the same tidying ' +
        'twice. A directory that APPEARED: it just crossed the line, which is the moment to ' +
        'group it rather than the moment to record it.',
    ).toEqual(OVER_THE_LINE);
  });
});
