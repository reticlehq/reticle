import { z } from 'zod';
import { asString, ReticleTool } from '@reticlehq/core';
import { sessionIdShape, type ToolDef, type ToolDeps } from '@/surface/tools/tool-kit.js';
import { resolveChangedFiles } from '@/command/cli/cli-flow-commands.js';
import { namedFlowsForSession } from './flow-store-for-session.js';
import { affectedSavedFlows } from './change/flow-sources.js';
import { RECORD_A_FLOW } from './suite/coverage.js';

interface AnswerFacts {
  changed: { failed?: boolean; reason?: string | undefined };
  since: string | undefined;
  fileCount: number;
  flowCount: number;
  changedCount: number;
  unmatchedRoot: string | undefined;
}

/**
 * Why the answer is empty, when that needs saying.
 *
 * Several situations produced the same empty answer: no files changed, no flows saved, and a git
 * ref that resolved to nothing. Only the first means "nothing to re-verify". The others mean the
 * question could not be answered, and re-running nothing on that basis is how a regression ships.
 */
function emptyAnswerReason(facts: AnswerFacts): string | undefined {
  const { changed, since, fileCount, flowCount, changedCount, unmatchedRoot } = facts;
  // No folder declares this project, so nothing here is about a checkout (#1550).
  if (unmatchedRoot !== undefined) {
    return `no flows here: no folder on disk declares this project, so its evidence goes to ${unmatchedRoot}. Run \`reticle init\` in the app's folder, or lease the tab from there.`;
  }
  // A git failure OUTRANKS every other explanation: the others describe a question that was
  // answered, and this one is a question that was not. Reporting "nothing changed" over a mistyped
  // ref or a shallow clone is how a regression ships past the tool meant to catch it.
  if (true === changed.failed) {
    return `could not read the diff for \`${String(since)}\`, so NOTHING was compared and this result proves nothing: ${changed.reason ?? 'git failed'}`;
  }
  if (0 === flowCount) {
    return `no saved flows exist yet, so nothing COULD be affected. ${RECORD_A_FLOW}`;
  }
  if (0 !== changedCount) {
    return undefined;
  }
  if (since === undefined && 0 === fileCount) {
    return 'no files were given and no `since` ref was passed, so nothing was compared — pass the files you edited, or a git ref';
  }
  return 'nothing changed against that input, so no saved flow needs re-verifying';
}

/**
 * `reticle_affected` — which saved flows must re-verify for a set of changed files.
 *
 * This logic already existed as `reticle affected`, deliberately kept off the MCP surface because an
 * advertised tool costs tokens on every turn whether or not it is used. That reasoning is right, and
 * this does not change it: the tool is NOT advertised by any profile. It is reachable through
 * `reticle_run`, so it costs nothing per turn and is still discoverable via `reticle_tools`.
 *
 * What the reasoning missed is who holds the question. The AGENT is the one that just edited files
 * and has to decide what to re-check; a shell command it may not be able to run is not an answer for
 * an MCP client that has no shell. Leaving it CLI-only meant the party with the diff could not ask
 * the party with the index.
 *
 * Unknown-provenance flows are returned as affected (fail-safe) AND listed separately, so "re-verify
 * this" is never confused with "this definitely touches your change".
 */
export const AFFECTED_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.AFFECTED,
    description:
      'Which saved flows must re-verify for a set of changed files. Pass the files you edited (and/or `since` for a git ref to diff against). Returns { changedFiles, affected, unknownProvenance } — `affected` is what to re-run, and `unknownProvenance` are flows included only because Reticle cannot tell which sources they cover, so they are re-verified by default rather than silently skipped.',
    example: { files: ['src/App.tsx'] },
    inputSchema: {
      ...sessionIdShape,
      files: z
        .array(z.string())
        .optional()
        .describe('Changed file paths, repo-relative (e.g. ["src/App.tsx"]).'),
      since: z
        .string()
        .optional()
        .describe('Git ref to diff against (e.g. "HEAD~1", "main"). Unioned with `files`.'),
    },
    outputSchema: {
      changedFiles: z.array(z.string()),
      affected: z.array(z.string()),
      unknownProvenance: z.array(z.string()),
    },
    handler: async (deps: ToolDeps, args) => {
      const files = Array.isArray(args['files'])
        ? (args['files'] as unknown[]).filter((f): f is string => 'string' === typeof f)
        : [];
      const since = 'string' === typeof args['since'] ? args['since'] : undefined;
      // The project of the tab being driven, not the folder the daemon started in (#1550). The flows
      // come from the store `flows` replays from, so a flow named here can be replayed by that name
      // (#1996). `git diff` runs in the project directory that holds that store.
      const { flows, projectDir, unmatchedRoot } = await namedFlowsForSession(
        deps,
        asString(args['sessionId']),
      );
      // A bucket of evidence is not a tree, so a `since` has nothing to diff against.
      const changed = await resolveChangedFiles(
        files,
        unmatchedRoot === undefined ? since : undefined,
        projectDir,
      );
      const changedFiles = changed.files;
      const result = affectedSavedFlows(flows, changedFiles);
      const why = emptyAnswerReason({
        changed,
        since,
        fileCount: files.length,
        flowCount: flows.length,
        changedCount: changedFiles.length,
        unmatchedRoot,
      });
      return {
        changedFiles,
        ...result,
        ...(why === undefined ? {} : { observed: true, note: why }),
      };
    },
  },
];
