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
import { ReticleTool } from './tool-names.js';
import { TOOLS } from './tools.js';

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

  it('a live tool is not redirected — it is callable as it stands', () => {
    expect(mergedNameRedirect(ReticleTool.SNAPSHOT)).toBeUndefined();
  });

  it('a name Reticle does not own is not redirected either', () => {
    expect(mergedNameRedirect('some_other_tool')).toBeUndefined();
  });

  it('EVERY name that is no longer a tool has a redirect — none left as a dead end', () => {
    const live = new Set(TOOLS.map((t) => t.name));
    // The two meta-tools are built at MCP registration time, so they are callable without being in TOOLS.
    const meta = new Set<string>([ReticleTool.TOOLS, ReticleTool.RUN]);
    const dead = Object.values(ReticleTool).filter((n) => !live.has(n) && !meta.has(n));
    expect(dead.length, 'the fixture would be pointless if nothing were merged').toBeGreaterThan(
      10,
    );
    expect(dead.filter((n) => mergedNameRedirect(n) === undefined)).toEqual([]);
  });
});
