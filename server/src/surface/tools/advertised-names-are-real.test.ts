/**
 * `defaultAdvertisedNames()` must name what the MCP actually advertises.
 *
 * It did not, and the gap was exactly one tool: the dispatch hatch. `buildDynamicTools` returns
 * `[reticle_tools, reticle_run]` unconditionally and the MCP appends BOTH to every surface, while
 * this function omitted `reticle_run` on the merged surface and carried a confident comment
 * explaining why - "naming a hatch that is not there is the same defect one level in".
 *
 * Two functions answering one question, and the one with the reasoning was the one the MCP never
 * calls. That is not a cosmetic disagreement:
 *
 * `server-instructions.ts` falls back to this list when it has no live one, and `surfaceVocabulary`
 * gates the sentence "Everything else is one hop: reticle_tools lists it, reticle_run calls it" on
 * the list containing `reticle_run`. So the instructions told agents the hatch was absent on a
 * surface that advertises it.
 *
 * And it fooled a reader into ACTING on it. Six user-facing recovery messages were rewritten to say
 * "this surface has no hatch" and two guards recording the opposite decision (#400, #521) were
 * superseded - all on this function's word, all wrong. Measured against a live daemon afterwards:
 * `reticle_run` is advertised on the default surface, and `reticle_run { tool: "reticle_lease" }`
 * reaches `reticle_lease`, which is the route those messages had been sending people down.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { advertisedTools } from '@/surface/mcp/mcp.js';
import { defaultAdvertisedNames, resolveToolSurface, TOOL_SURFACE } from './tool-surface.js';

/*
 * The REAL function the MCP uses, never a reimplementation of it.
 *
 * A third answer to "what is advertised" is how there came to be two, and a guard that models the
 * pipeline instead of calling it can agree with neither.
 */
const reallyAdvertised = (surface: ReturnType<typeof resolveToolSurface>): Set<string> =>
  new Set(advertisedTools(surface).map((tool) => tool.name));

describe('the advertised-names list and the advertised tools', () => {
  it('agrees with the MCP about the live surface', () => {
    const surface = resolveToolSurface();
    const claimed = new Set(defaultAdvertisedNames());
    const real = reallyAdvertised(surface);
    const missing = [...real].filter((name) => !claimed.has(name));
    const invented = [...claimed].filter((name) => !real.has(name));
    expect(
      { missing, invented },
      'server-instructions falls back to this list, so a name wrong here is wrong in what every ' +
        'agent is told at handshake',
    ).toEqual({ missing: [], invented: [] });
  });

  /* The specific one that was wrong, named so a regression reads as itself rather than as a diff. */
  it('includes the dispatch hatch, which every surface gets', () => {
    expect(defaultAdvertisedNames()).toContain(ReticleTool.RUN);
    expect(defaultAdvertisedNames()).toContain(ReticleTool.TOOLS);
  });

  it('is not vacuous — the surface really is the merged one by default', () => {
    expect(resolveToolSurface()).toBe(TOOL_SURFACE.MERGED);
    expect(defaultAdvertisedNames().length).toBeGreaterThan(5);
  });
});
