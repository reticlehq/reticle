import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';

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
  'adapters/realm/browser/src/dom': 12,
  'adapters/realm/browser/src/observers': 24,
  // 17 since the HUD's position primitives left `presenter-drag.ts` for their own leaf: the drag
  // gesture re-syncs the dock layout, and the dock layout reads the HUD's position, so the two files
  // needed each other over primitives that belong to neither.
  // 18 with `presenter-account.ts`: whether this machine is signed in, said the same way by every
  // panel that shows it. One builder rather than the same rule copied into three panels — and the
  // rule is load-bearing, because absent account state means UNKNOWN and a panel that read it as
  // signed-out would ask a paying user to sign in every time they opened one.
  // 19 with `presenter-account-styles.ts`, which is the other half of that same consolidation: the
  // account control used to be styled three times, once per panel, and the copies had drifted to
  // different gaps and avatar sizes. Raised rather than grouped because this directory already pairs
  // a component with its stylesheet — settings, report and shell all do — so the file sits where the
  // convention puts it, and moving one pair out would be the inconsistent choice.
  // 20 with `presenter-offer.ts`, the one thing this HUD advertises: the card, its copy, the rules
  // that keep it from nagging, and its stylesheet, in one file. Raised rather than grouped for the
  // same reason as the line above -- it is a presenter surface beside every other presenter surface,
  // and a `promo/` directory holding exactly one file would be a category invented for a single member.
  'adapters/realm/browser/src/presenter': 21, // + presenter-talk.ts, the founder card beside its sibling presenter-offer.ts
  // Newly over the line at 11, with `presenter-safe-html.ts`. It crossed because two SECURITY
  // helpers left `presenter-report.ts` when the account capsule became their second caller: HTML
  // escaping, and the dashboard-url scheme check that exists because `javascript:` once produced a
  // link running code inside the developer's own app. A security rule living in two files gets
  // fixed in one of them, so the duplicate was not an option.
  'adapters/realm/browser/src/presenter/chrome': 11,
  /*
   * 12 because `verdict-attribution.ts` earns its own module, and the reason is measured rather than
   * tidy: folded into `verified-constants.ts` it added 687 B to what EVERY page downloads just for
   * loading the SDK, which `first-load-size` caught. The browser never needs to know whose problem
   * an unproved verdict is — that is read where a verdict is emitted — so a separate module lets the
   * bundler drop it. Two guards pulling opposite ways, and the one about a cost every developer pays
   * on every page load wins over the one about how many files sit in a directory.
   *
   * 15 since `predicate-tree.ts`, and it is the same trade a second time. A step's `expect` became a
   * `Predicate`, so replay has to read INSIDE the tree — drop the element clause a healed locator
   * would fake, ask whether a state is asserted — and the reader for that was living in
   * `server/src/language/flows`. The `directory-reach` guard refused it there the moment `journal`
   * needed it too, and its own advice ("most reaches were a file filed somewhere odd") was right:
   * a shallow walk over the contract's own type belongs beside the contract. Moving it here took a
   * cross-layer reach out of the server and left the file count as the only cost.
   */
  'core/src/verdict': 15,
  'core/src/wire': 16,
  // 16 since `snapshot-tree.ts`. The snapshot tree is a format the BROWSER writes and several
  // things on the Node side read back, and its parser was living beside the MCP tool handlers — so
  // every other reader imported from the tool surface to parse a string the tool surface does not
  // own, and the directory-reach guard refused the second layer that needed it. Moving it here put
  // it with the other wire formats and took a cross-layer reach OUT of `features/crawl` as well.
  //
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
  'core/src/artifacts': 14,
  'engine/src/evidence': 18,
  // 18 since the last two cycles in this package were removed: `predicate-eval-kit.ts` (the result
  // type and the four comparisons the oracles are written in) and `predicate-session.ts` (what the
  // engine needs from a session). Both were reached back out of the modules that call their readers.
  // 19 with `body-key-fragment.ts`, the rule that a response-body needle found only inside a KEY
  // name grades inconclusive rather than pass. Raised on purpose rather than folded into
  // `predicate-eval.ts`: it is a pure rule with an incident behind it, and it is the kind of thing
  // that gets quietly re-broken when it lives inside the evaluator it constrains. This directory is
  // now the largest flat one in the package and is the next thing here worth grouping.
  'engine/src/question/predicate': 20,
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
  // 34 since `live-call-text.ts`: rewriting advice so every tool it names is one the reader was
  // actually given. It sits HERE and not beside the briefing's `surface-vocabulary.ts` because it
  // runs at the MCP result boundary over every payload, not only the instructions -- which is the
  // gap that let three pieces of guidance route to a dispatch hatch the surface removes by name.
  // 35 since `inspect-tool.ts`: `reticle_inspect` left `tools.ts` when the refusal it owes a caller
  // who gives no ref -- and the explanation of why the merged surface cannot enforce that -- pushed
  // that file past the 1000-line cap. It is a tool module beside `act-tools.ts` and
  // `observe-tools.ts` rather than a new leaf, because one tool is not a grouping.
  // 36 since `gap-novelty.ts`: the per-session filter that says an instrumentation gap's remedy
  // once instead of on every call. It sits beside `act-tools.ts`/`observe-tools.ts` because BOTH
  // assemble responses that carry gaps, and it holds session-scoped state -- so it belongs at the
  // surface, not in the pure engine that computes the gaps. Recorded rather than grouped: one
  // filter is not a cluster, and `tools/act/` is for the act path specifically.
  // 37 since `harness-plan.ts`: what a drive is FOR, read out of `.reticle` before it starts —
  // every recorded journey with the consequence that must still hold, and the declared intent no
  // flow asserts. Recorded rather than grouped, and it belongs beside `harness-explore.ts` for the
  // reason the directory-reach guard insists on: `features/harness` is a SINK that imports nothing
  // from this package, so anything the drive needs to be HANDED has to be assembled out here.
  // 38 with `first-sentence.ts`, the one implementation of a summary that two surfaces had a copy
  // of -- and only one copy knew that `e.g.` does not end a sentence, so the tool catalogue cut
  // `reticle_session`'s MANDATORY handback out of its own summary. It sits beside the surfaces that
  // call it rather than in a `text/` directory holding one file.
  'server/src/surface/tools': 38,
  // Crossed the line when a planned step gained its own `expect`: the grading rule and its test
  // joined the act cluster (preflight, target, retry, capsule). Recorded rather than grouped,
  // because this directory IS the grouping -- these files were split out of act-tools.ts when it
  // hit the line cap, and splitting them again would scatter one cohesive unit across two homes.
  /*
   * 12 because `already-true.ts` had to leave `act-tools.ts`, which sits ON the 1000-line cap, and
   * rule 6 says split before adding. The obvious home refused it: `act-preflight.ts` states its own
   * cohesion as "decidable without touching the page", and reading whether a consequence is already
   * true queries the page. Two guards in tension, and the line cap is the one whose rule is explicit
   * about what to do.
   */
  'server/src/surface/tools/act': 12,
  // 19 since `setup-mcp-cli.ts`: the terminal half of `reticle setup mcp`, which the one-line
  // installer runs before any project exists. It sits HERE and not in `setup/` because the reach
  // guard refused `command -> setup` and CLI handlers already live in this directory.
  'server/src/command/cli': 21, // + tutorial.ts: one sequence, two audiences, ending at a verdict; + report-command.ts, a command beside its siblings
  // 17 since the installer's Node half: `setup-mcp.ts` (which agents are here, and merging into the
  // configs they already keep) and `setup-install.ts` (the three steps only the shell could time).
  // Both are pure — their telemetry reporter is INJECTED, because this directory does not own a
  // telemetry client and the reach guard was right to say so.
  // 15 since `drive-agent.ts` and `drive-plan.ts` left with the drive itself: onboarding stops at a
  // connected app, and the stage that proves a flow runs a model inside the daemon rather than
  // spawning a second agent CLI. Lowered in the same commit, which is what locks the gain in.
  'server/src/command/setup': 16,
  // Crossed the line with `drive-url-stamp.ts`: the mark that tells a page Reticle opened it for
  // itself. Its own leaf because the SDK reads the same constant to decide not to show a human a
  // first-run tour over a page nobody is looking at -- a rule split across two packages is worth
  // one file that names it.
  'server/src/portal/input': 11,
  // 22 since `session-verdict-facts.ts` was extracted (the count is source files, not tests): both
  // verdict-producing tools were threading the same session facts into `decideVerified` with the
  // same conditional-spread idiom, and a third fact would have been a third copy. Raised on
  // purpose — the facts a session contributes to a verdict belong beside the session, not
  // duplicated in two tool files.
  'server/src/portal/session': 22,
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
  // 13 with `drive-run-flush.ts`, which publishes a session's run while the drive is still running.
  // It belongs beside `session-end.ts` for the same reason the line above gives: teardown owns the
  // final write of that artifact, and the flush is the same write on a different trigger. Putting it
  // near the event bus instead would pull the run store and the journal in behind it.
  // 14 with `self-observation.ts`: the rule that Reticle does not durably record the browser
  // fetching Reticle's own SDK. It is its own file because the predicate has to be a pure function
  // of the URL and testable without a journal -- both halves of a request/response pair must get the
  // same answer, or filtering one half leaves the other unpaired and the engine reports a request
  // that completed as one that hung.
  // 15 since `route-template.ts`: the key an envelope's statistics accumulate under. Its own file
  // rather than a helper inside `deviation-service`, because BOTH the service that writes the
  // envelope and the report that reads it must key on the identical value — a private copy on one
  // side is how the two would silently disagree, and a lookup that misses every envelope is exactly
  // the defect it was written to fix.
  'server/src/memory/journal': 15,
  // 11 when the artifact-address files landed: `project-for-root.ts`, `artifact-root-resolver.ts`
  // and the roster that pins them. Recorded rather than grouped, and the reason is the sibling
  // guard: the natural home for "which directory does this write to" is `project/dir`, whose whole
  // subject that is — but these four files ask the question with a ToolDeps, a discovered config
  // and a project store in hand, so moving them there would add `dir -> tools`, `dir -> config`,
  // `dir -> resolve` and `dir -> project`, turning a leaf directory into one that reaches for four
  // others. A flat file is cheaper than a new mutual pair. Group them when the address question
  // stops needing the caller's dependencies to answer it.
  'server/src/memory/project': 11,
  // 35 since the setup funnel: `onboarding-funnel.ts` (the one emit chokepoint), `onboarding-firsts.ts`
  // (the first look / act / verdict of a run, which only the daemon can witness) and
  // `install-trace.ts` (draining what the installer could not report, because it ran before there
  // was a CLI). Three files rather than one: they answer at three different moments.
  // 36 with `harness-drive.ts`: the span that says a verdict came from Reticle driving the app
  // rather than from the user's own agent. It is a module and not a flag on a call because the two
  // are indistinguishable at the emit site otherwise, and every activation number built on verdicts
  // reads a drive we performed as adoption we did not earn. Raised rather than grouped: this
  // directory is already the largest flat one here and grouping it is its own piece of work.
  'server/src/telemetry': 36,
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
