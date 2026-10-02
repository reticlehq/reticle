/**
 * The files `reticle init` WRITES into somebody's repo, checked against the surface they will meet.
 *
 * MEASURED by installing into a fresh app and driving it: `.claude/commands/reticle.md` — the first
 * thing an agent runs on a new project — told the reader to take a tab with
 * `reticle_run({ tool: "reticle_lease", … })`, and the default surface advertises neither name. The
 * always-loaded rule did the same for `reticle_run { tool, args }`, describing it as the way to
 * "reach any other by name".
 *
 * `live-call-text.ts` rewrites this class of thing at the RESULT boundary, and `agent-writer.test.ts`
 * covers the skill the server writes. A file written to disk once at install time passes through
 * neither: it is read months later, by an agent that never called a tool to get it.
 *
 * Judged against `advertisedTools`, NOT against the tool table. The table for the merged surface is
 * every tool with some of them folded together; the advertised set is the nine an agent is handed.
 * Checking the table is a guard that cannot fail, which `advertisedConfig` already warns about in
 * mcp.ts — and which the first version of this check did anyway, passing with `reticle_run` sitting
 * in the guidance.
 *
 * Read from disk rather than imported: `@reticlehq/init` does not export these strings, and widening
 * its public API to be testable from here is the wrong trade.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';
import { advertisedTools } from '@/surface/mcp/mcp.js';
import { TOOL_SURFACE } from './tool-surface.js';

/**
 * The sources of the guidance init installs into a project, and the guidance it PRINTS.
 *
 * The printed half was added after `install-gate (ubuntu, cra)` went red on 3.1.0: `init` exited 1
 * and its own fallback -- the steps a reader follows precisely BECAUSE the run did not finish --
 * told them to call `reticle_sessions`, `reticle_snapshot`, `reticle_act_sequence`, `reticle_record`
 * and `reticle_flow_save`. Five names, none of them advertised, on the one path where the reader
 * has nothing else to go on. The browser-launcher fallback beside it named
 * `reticle_run({ tool: "reticle_lease", ... })`, which is neither advertised nor reachable.
 *
 * Written and printed are the same defect with the same fix, so they are one list: a guard that
 * covered only the written half passed through this release with the printed half broken.
 */
const WRITTEN_GUIDANCE = [
  join(REPO_ROOT, 'init', 'src', 'register', 'slash-command.ts'),
  join(REPO_ROOT, 'init', 'src', 'project', 'agent-rules.ts'),
  join(REPO_ROOT, 'server', 'src', 'command', 'setup', 'remaining-steps.ts'),
  join(REPO_ROOT, 'server', 'src', 'command', 'setup', 'setup-command.ts'),
];

/**
 * Block comments go as REGIONS, not as lines that look like one.
 *
 * Filtering lines that START with `*` also ate every Markdown bold line — `**A tool you need is
 * missing?**` — which is exactly where the guidance lives, so that version saw almost nothing and
 * passed for the wrong reason. A `reticle_state` in a header explaining an old defect is not advice,
 * and failing on one teaches the next reader to delete the explanation.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Every `reticle_*` tool name in a piece of guidance. `reticle_*` as prose is not a call. */
function toolNamesIn(source: string): string[] {
  return [...new Set(withoutComments(source).match(/reticle_[a-z][a-z_]*/g) ?? [])];
}

describe('the guidance init writes and prints names only tools the reader was given', () => {
  const advertised = new Set(advertisedTools(TOOL_SURFACE.MERGED).map((tool) => tool.name));

  it('finds the sources of the guidance init installs and prints', () => {
    for (const file of WRITTEN_GUIDANCE) expect(existsSync(file), file).toBe(true);
  });

  /*
   * The negative control for the check below: if this set ever goes empty, the guard is vacuous.
   *
   * Corpus-wide rather than per-file. A file earns its place here by being guidance a reader acts
   * on, not by currently containing a tool name: `setup-command.ts` names none today, because the
   * fix for its defect was to replace `reticle_run({ tool: "reticle_lease", ... })` with the CLI's
   * own `reticle open <url>`. Demanding a name from every file would have forced that file back
   * out of the list precisely because it had been fixed.
   */
  it('reads real tool names out of them', () => {
    const all = WRITTEN_GUIDANCE.flatMap((file) => toolNamesIn(readFileSync(file, 'utf8')));
    expect(
      all.length,
      'no tool names found at all — the matcher has stopped matching',
    ).toBeGreaterThan(0);
    // The file this guard was extended for. Its advice is what a reader follows when init FAILED,
    // so it going quiet would be the guard losing the case it was written for.
    const fallback = WRITTEN_GUIDANCE.find((f) => f.endsWith('remaining-steps.ts'));
    expect(toolNamesIn(readFileSync(fallback ?? '', 'utf8')).length).toBeGreaterThan(0);
  });

  it('every reticle_* name in them is on the default surface', () => {
    const broken: string[] = [];
    for (const file of WRITTEN_GUIDANCE) {
      for (const name of toolNamesIn(readFileSync(file, 'utf8'))) {
        if (!advertised.has(name)) broken.push(`${file.slice(REPO_ROOT.length + 1)} -> ${name}`);
      }
    }
    expect(
      broken,
      `guidance init writes or prints names tools the default surface does not advertise: ${broken.join(', ')}`,
    ).toEqual([]);
  });
});
