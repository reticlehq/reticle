import { describe, expect, it } from 'vitest';
import { TOOLS, tableForSurface } from './tools.js';
import { filterTools, TOOL_SURFACE } from './tool-surface.js';
import { mergedNameRedirect } from './merged-name-redirect.js';

/**
 * A name that used to work must never answer "not found".
 *
 * THE INCIDENT. When the nine-tool surface became the default, every name it had merged away started
 * coming back as the MCP SDK's `Tool <name> not found` — which is indistinguishable from "this tool
 * never existed", and is the exact belief `unadvertised-help.ts` was written to stop an agent
 * forming. `reticle_sessions` was the worst of them: Reticle's own MCP instructions tell an agent to
 * confirm its setup with that call, so the first thing a new user's agent did was ask for a tool and
 * be told it does not exist.
 *
 * The cause was three sources that had to agree and did not. `mergedNameRedirect` built its
 * tombstones from `MERGE_PLANS`, the surface's own folds lived in `SURFACE_MERGE_PLANS`, and
 * `list`/`feedback` were injected inline inside `applyMerges`' argument — so a name's redirect
 * existed only if you happened to be reading the list it was declared in. `MERGED_SURFACE_PLANS` is
 * now the single list, and this asserts the property rather than the plumbing: whatever a surface
 * stops advertising, something must say where it went.
 *
 * Derived from the two surfaces, never a written-out list of names — a hand-maintained migration
 * list is one merge away from being wrong, and wrong is worse than absent here because the agent
 * retries into it.
 */
describe('every name the merged surface drops still says where it went', () => {
  const advertisedOn = (surface: (typeof TOOL_SURFACE)[keyof typeof TOOL_SURFACE]): Set<string> =>
    new Set(filterTools([...tableForSurface(surface)], surface).map((tool) => tool.name));

  it('has two surfaces to compare, so a pass cannot mean it compared nothing', () => {
    // Both sets empty would make the loop below vacuous and green.
    expect(advertisedOn(TOOL_SURFACE.DEFAULT).size).toBeGreaterThan(10);
    expect(advertisedOn(TOOL_SURFACE.MERGED).size).toBeGreaterThan(5);
  });

  it('answers for every tool the wider surface advertises and the merged one does not', () => {
    const wider = advertisedOn(TOOL_SURFACE.DEFAULT);
    const merged = advertisedOn(TOOL_SURFACE.MERGED);
    const dropped = [...wider].filter((name) => !merged.has(name));
    expect(
      dropped.length,
      'the merged surface drops nothing, so this guard is watching nothing',
    ).toBeGreaterThan(0);

    const silent = dropped.filter((name) => mergedNameRedirect(name) === undefined);
    expect(
      silent,
      'these names are advertised on the wider surface and gone from the merged one, with nothing ' +
        'to say where they went. An agent calling one gets the SDK\'s "Tool <name> not found", ' +
        'which reads as "no such capability" rather than "renamed" — so it stops trying instead of ' +
        'making the one call that works. Add the fold to MERGED_SURFACE_PLANS, or a tombstone in ' +
        'merged-name-redirect.ts if the name has no direct replacement.',
    ).toEqual([]);
  });

  it('points every redirect at a tool that actually exists', () => {
    // A redirect naming a tool that was itself renamed is worse than none: it costs a turn AND
    // teaches a second wrong name.
    const names = new Set(TOOLS.map((tool) => tool.name));
    const mergedNames = new Set(tableForSurface(TOOL_SURFACE.MERGED).map((tool) => tool.name));
    const broken: string[] = [];
    for (const tool of tableForSurface(TOOL_SURFACE.DEFAULT)) {
      const moved = mergedNameRedirect(tool.name);
      if (moved === undefined) continue;
      if (!names.has(moved.tool) && !mergedNames.has(moved.tool)) {
        broken.push(`${tool.name} -> ${moved.tool}`);
      }
    }
    expect(broken, 'these redirects name a tool that is not in any table').toEqual([]);
  });
});
