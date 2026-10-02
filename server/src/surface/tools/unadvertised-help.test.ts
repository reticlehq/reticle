/**
 * "Tool reticle_coverage not found" is a lie, and it costs a whole sweep.
 *
 * Under the default profile the server advertises 16 of 46 tools. The other 30 are deliberately
 * un-advertised — the schema for all 46 is re-sent every turn, and the trim is most of why hybrid is
 * cheap — but they remain fully callable through `reticle_run`. That design is sound and guarded
 * (profile-reachability.test.ts).
 *
 * What was not sound is what an agent is told when it calls one by NAME. The MCP SDK answers
 * `Tool <name> not found`, which is indistinguishable from "this tool does not exist", so an agent
 * that trusts it stops trying. Reported from a real sweep of a Next app-router project: a first pass
 * scored 25 failures that were nothing of the kind — every one of those tools worked when called
 * through `reticle_run` seconds later.
 *
 * A name Reticle owns must never come back as "not found". It comes back as "not advertised under
 * this profile, here is how to call it, and here is how to advertise it".
 */

import { describe, expect, it } from 'vitest';
import { unadvertisedToolHelp } from './unadvertised-help.js';
import { ReticleTool } from '@reticlehq/core';
import { TOOLS } from './tools.js';
import { ADVERTISE_ALL_ENV, TOOL_PROFILE_ENV } from './tool-surface.js';

const ADVERTISED = new Set<string>([ReticleTool.SNAPSHOT, ReticleTool.RUN, ReticleTool.TOOLS]);
const KNOWN = new Set(TOOLS.map((t) => t.name));

describe('a Reticle tool that is real but not advertised', () => {
  it('is not reported as missing', () => {
    const help = unadvertisedToolHelp(ReticleTool.COVERAGE, ADVERTISED, KNOWN);
    expect(help).toBeDefined();
    expect(help).not.toContain('not found');
  });

  it('names the escape hatch that actually works, with the call spelled out', () => {
    const help = unadvertisedToolHelp(ReticleTool.FLOW_HEAL, ADVERTISED, KNOWN) ?? '';
    expect(help).toContain('reticle_run');
    expect(help).toContain(ReticleTool.FLOW_HEAL);
  });

  it('names the switch that actually takes effect, not the retired one', () => {
    // EXPLORE rather than COVERAGE: coverage is an ACTION on reticle_verify now, so it correctly
    // gets the merge redirect instead of this message — which is better guidance, and would make
    // this assertion pass or fail for a reason that has nothing to do with the env var.
    const help = unadvertisedToolHelp(ReticleTool.EXPLORE, ADVERTISED, KNOWN) ?? '';
    // This asserted RETICLE_TOOL_PROFILE for months, which is RETIRED: resolveToolSurface maps its
    // old values to a surface and everything else — including the 'all' this message told agents to
    // set — to DEFAULT. So the guidance named a variable that could not do what the sentence
    // promised, and the test pinned the wrong half of it.
    expect(help).toContain(ADVERTISE_ALL_ENV);
    expect(help).not.toContain(TOOL_PROFILE_ENV);
  });

  it("stays silent for an advertised tool — that call is the SDK's business, not ours", () => {
    expect(unadvertisedToolHelp(ReticleTool.SNAPSHOT, ADVERTISED, KNOWN)).toBeUndefined();
  });

  it('stays silent for a name Reticle does not own', () => {
    // Inventing guidance for someone else's tool would be worse than the original error.
    expect(unadvertisedToolHelp('some_other_servers_tool', ADVERTISED, KNOWN)).toBeUndefined();
  });

  it('covers every un-advertised tool, not a hand-listed few', () => {
    const missing = TOOLS.map((t) => t.name)
      .filter((n) => !ADVERTISED.has(n))
      .filter((n) => unadvertisedToolHelp(n, ADVERTISED, KNOWN) === undefined);
    expect(missing).toEqual([]);
  });
});

/**
 * The advice has to be true on the surface that is actually shipping.
 *
 * Every test above hands `reticle_run` to the advertised set, so the case the default profile is in
 * was never covered. On the MERGED surface — what a daemon advertises with `RETICLE_ADVERTISE_ALL_TOOLS`
 * unset — `reticle_run` is not advertised either, and `reticle_tools` says so in as many words:
 * "there is no hidden tail and no dispatch hatch to reach one".
 *
 * MEASURED against a live daemon while driving bench-app:
 *
 *     reticle_baseline  -> "It is NOT missing: invoke it with reticle_run { tool: … }"
 *     reticle_run       -> "Tool reticle_run not found"
 *
 * So the one message whose entire purpose is to stop an agent concluding "this does not exist"
 * handed it a call that does not exist, and cost the turn it was written to save. The fix this file
 * describes — "a name Reticle owns never comes back as not found; it comes back with the call that
 * WORKS" — has to mean the call that works HERE.
 */
describe('when the dispatch hatch is not advertised either', () => {
  const MERGED = new Set<string>([ReticleTool.LOOK, ReticleTool.TOOLS]);

  it('does not tell an agent to call a tool this surface does not have', () => {
    const help = unadvertisedToolHelp(ReticleTool.BASELINE, MERGED, KNOWN);
    expect(help).toBeDefined();
    expect(help ?? '').not.toContain(ReticleTool.RUN);
  });

  it('still refuses to let the name read as missing, and says what to do instead', () => {
    const help = unadvertisedToolHelp(ReticleTool.BASELINE, MERGED, KNOWN) ?? '';
    expect(help).toContain(ReticleTool.BASELINE);
    // The only route that actually opens it on this profile.
    expect(help).toContain(ADVERTISE_ALL_ENV);
  });

  // The existing advice is still right wherever the hatch IS advertised.
  it('keeps pointing at the hatch on a profile that has one', () => {
    const withHatch = new Set<string>([ReticleTool.RUN, ReticleTool.TOOLS]);
    expect(unadvertisedToolHelp(ReticleTool.BASELINE, withHatch, KNOWN) ?? '').toContain(
      ReticleTool.RUN,
    );
  });
});
