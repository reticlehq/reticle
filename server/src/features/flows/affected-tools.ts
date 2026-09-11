import { z } from 'zod';
import { ReticleTool } from '@reticlehq/core';
import type { ToolDef, ToolDeps } from '../../agent/tools/tools.js';
import { loadNamedFlows, resolveChangedFiles } from '../../command/cli/cli-flow-commands.js';
import { sessionRoot, sessionProjectId } from '../project/session-root.js';
import { affectedSavedFlows } from './change/flow-sources.js';

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
      // Same address as verify_change, resolved the same way: `deps.reticleRoot` is the configured
      // project directory (the daemon's cwd is not), and the session names which project's flows.
      const changed = await resolveChangedFiles(files, since, deps.reticleRoot);
      const changedFiles = changed.files;
      // No `sessionId` on this tool's surface, and it does not need one: passing `undefined`
      // resolves the single connected session, and falls back exactly as before when it cannot.
      // Adding an argument here would be a surface change to fix an addressing bug.
      const flows = await loadNamedFlows(
        deps.fs,
        sessionRoot(deps, undefined),
        sessionProjectId(deps, undefined),
      );
      const result = affectedSavedFlows(flows, changedFiles);
      // Three different situations produced the same empty answer: no files changed, no flows saved,
      // and a git ref that resolved to nothing. Only the first means "nothing to re-verify"; the
      // others mean the question could not be answered, and re-running nothing on that basis is how a
      // regression ships. Say which one it is.
      const why =
        // A git failure OUTRANKS every other explanation: the others describe a question that was
        // answered, and this one is a question that was not. Reporting "nothing changed" over a
        // mistyped ref or a shallow clone is how a regression ships past the tool meant to catch it.
        changed.failed
          ? `could not read the diff for \`${String(since)}\`, so NOTHING was compared and this result proves nothing: ${changed.reason ?? 'git failed'}`
          : 0 === flows.length
            ? 'no saved flows exist yet, so nothing COULD be affected — record one with reticle_record then reticle_flow_save'
            : 0 === changedFiles.length
              ? since === undefined && 0 === files.length
                ? 'no files were given and no `since` ref was passed, so nothing was compared — pass the files you edited, or a git ref'
                : 'nothing changed against that input, so no saved flow needs re-verifying'
              : undefined;
      return {
        changedFiles,
        ...result,
        ...(why === undefined ? {} : { observed: true, note: why }),
      };
    },
  },
];
