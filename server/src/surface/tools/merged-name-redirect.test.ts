/**
 * A merged tool's OLD member name is a dead call target.
 *
 * Confirmed live in a field sweep: `reticle_run { tool: "reticle_record_start" }` -> `unknown tool`.
 * Same for `reticle_diff`, `reticle_yield`, `reticle_flow_load`, `reticle_lease_acquire`, and the
 * rest — 22 names in all. They are still exported from `ReticleTool`, still referenced throughout the
 * codebase, and still what an agent trained on an earlier release (or reading a stale doc, or
 * guessing from the merged tool's own description, which names every action) will reach for.
 *
 * `unknown tool` is the wrong answer for all of them: the capability exists, it just moved. And the
 * mapping is not something to write out by hand — `MERGE_PLANS` and `RETIRED_FROM_SURFACE` already
 * declare it, so the redirect is DERIVED from them and cannot drift when the next merge lands.
 */

import { describe, expect, it } from 'vitest';
import { mergedNameRedirect } from './merged-name-redirect.js';
import { unadvertisedToolHelp } from './unadvertised-help.js';
import { ReticleTool } from '@reticlehq/core';
import { TOOLS, MERGED_TOOLS } from './tools.js';

describe('an old member name points at where the capability went', () => {
  it.each([
    [ReticleTool.RECORD_START, ReticleTool.RECORD, 'start'],
    [ReticleTool.DIFF, ReticleTool.BASELINE, 'diff'],
    [ReticleTool.FLOW_LOAD, ReticleTool.FLOW, 'load'],
    [ReticleTool.YIELD, ReticleTool.SESSION, 'yield'],
    [ReticleTool.LEASE_ACQUIRE, ReticleTool.LEASE, 'acquire'],
    [ReticleTool.NARRATE, ReticleTool.SESSION, 'narrate'],
  ])('%s -> %s { action: "%s" }', (old, tool, action) => {
    const redirect = mergedNameRedirect(old);
    expect(redirect?.tool).toBe(tool);
    expect(redirect?.action).toBe(action);
  });

  it('a RETIRED name says where the capability went, with no action to pass', () => {
    const redirect = mergedNameRedirect(ReticleTool.REFRESH);
    expect(redirect).toBeDefined();
    expect(redirect?.action).toBeUndefined();
    expect(redirect?.note).toBeTruthy();
  });

  it('a tool the surface advertises is never redirected — it is callable as it stands', () => {
    /*
     * This used to assert that `reticle_snapshot` has no redirect at all, on the grounds that it is
     * a live tool. That stopped being true of every surface: on the nine-tool one it IS merged away,
     * into `reticle_look { action: "page" }`, and having no redirect there was the defect — the SDK
     * answered "Tool reticle_snapshot not found" to an agent following our own instructions.
     *
     * So the invariant moved to where the decision is actually made. `mergedNameRedirect` is
     * surface-agnostic and answers "where did this name go under a merge"; `unadvertisedToolHelp`
     * is what consults it, and only for a name the live surface does NOT advertise. A redirect
     * offered for a tool the agent can already call is the failure this guards, and it is a
     * property of that gate, not of the map.
     */
    const advertised = new Set<string>([ReticleTool.SNAPSHOT, ReticleTool.QUERY]);
    const known = new Set(TOOLS.map((tool) => tool.name));
    expect(unadvertisedToolHelp(ReticleTool.SNAPSHOT, advertised, known)).toBeUndefined();
    // …and the same name on a surface WITHOUT it gets the move rather than a dead end.
    const help = unadvertisedToolHelp(ReticleTool.SNAPSHOT, new Set([ReticleTool.LOOK]), known);
    expect(help).toContain(ReticleTool.LOOK);
  });

  it('a name Reticle does not own is not redirected either', () => {
    expect(mergedNameRedirect('some_other_tool')).toBeUndefined();
  });

  it('EVERY name that is no longer a tool has a redirect — none left as a dead end', () => {
    // Both tables. `reticle_look` is a live tool on the `merged` surface and appears in no other, so
    // reading TOOLS alone reports it as a merged-away name with no redirect — a dead end that is the
    // exact opposite of the truth. A redirect for it would point an agent AWAY from a tool it can call.
    const live = new Set([...TOOLS, ...MERGED_TOOLS].map((t) => t.name));
    // The two meta-tools are built at MCP registration time, so they are callable without being in TOOLS.
    const meta = new Set<string>([ReticleTool.TOOLS, ReticleTool.RUN]);
    const dead = Object.values(ReticleTool).filter((n) => !live.has(n) && !meta.has(n));
    expect(dead.length, 'the fixture would be pointless if nothing were merged').toBeGreaterThan(
      10,
    );
    expect(dead.filter((n) => mergedNameRedirect(n) === undefined)).toEqual([]);
  });
});
