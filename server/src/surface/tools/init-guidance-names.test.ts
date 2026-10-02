/**
 * The text `reticle init` writes into somebody's repository must name tools that surface advertises.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────────────────────────
 * This release made the merged nine-tool surface the default (`resolveToolSurface` fell back to
 * `TOOL_SURFACE.DEFAULT` at 2.14.0 and falls back to `TOOL_SURFACE.MERGED` now). Ten names moved
 * behind an action. `init` kept writing seven of them into every new project's agent rules and
 * slash command — `reticle_sessions`, `reticle_snapshot`, `reticle_state`, `reticle_network`,
 * `reticle_console`, `reticle_feedback`, `reticle_act_sequence`.
 *
 * So a brand-new user's first drive followed instructions Reticle itself had just written, naming
 * tools Reticle itself does not advertise. A call to one gets a redirect rather than a lie, which is
 * the part that worked — but an unadvertised name is invisible to an agent's `allowedTools`
 * allowlist and to MCP permission rules, and those refuse before any redirect can answer.
 *
 * `documented-names.test.ts` could not catch it: it asks whether a name EXISTS, and all ten do.
 *
 * Asked against `mergedNameRedirect` rather than a list kept here, because a hand-written list of
 * retired names is one merge away from being wrong, and wrong is worse than absent — the next merge
 * would leave this file green while `init` went back to writing ghosts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';
import { mergedNameRedirect } from './merged-name-redirect.js';

/** The files whose CONTENT is copied into a user's project, verbatim, by `reticle init`. */
const GENERATED_GUIDANCE = [
  join('init', 'src', 'project', 'agent-rules.ts'),
  join('init', 'src', 'register', 'slash-command.ts'),
];

/**
 * Only the lines that become the user's file.
 *
 * A comment in these modules is read by us, not by the agent, and one of them deliberately records
 * what a tool was CALLED when an incident happened. Renaming that would make the history wrong, so
 * comment lines are not guidance and are not checked.
 */
function guidanceLines(source: string): { line: string; number: number }[] {
  return source
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}

describe('init writes guidance an agent can actually follow', () => {
  it('names the guidance files it checks, so a rename cannot empty this test', () => {
    for (const file of GENERATED_GUIDANCE) {
      expect(readFileSync(join(REPO_ROOT, file), 'utf8').length).toBeGreaterThan(1000);
    }
  });

  for (const file of GENERATED_GUIDANCE) {
    it(`${file} names no tool that moved behind an action`, () => {
      const retired: string[] = [];
      for (const { line, number } of guidanceLines(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
        for (const match of line.matchAll(/(reticle_[a-z0-9_]+)/g)) {
          const name = match[1] as string;
          const redirect = mergedNameRedirect(name);
          /*
           * A redirect ONTO ITSELF is not a retirement.
           *
           * `reticle_observe` and `reticle_assert` are both advertised and both carry an entry,
           * because their bare call shape moved behind an action rather than the tool moving
           * anywhere. The name in the guidance is reachable; only the argument list changed. The
           * first draft of this guard failed on five correct lines for that reason.
           */
          if (redirect === undefined || redirect.tool === name) continue;
          retired.push(`${file}:${number} ${name} -> ${redirect.tool}`);
        }
      }
      expect(
        retired,
        "written into a user's repository, but not advertised on the surface they get. An " +
          'allowlist or a permission rule naming it refuses before any redirect can answer.',
      ).toEqual([]);
    });
  }
});
