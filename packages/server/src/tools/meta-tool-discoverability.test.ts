/**
 * The two meta-tools' descriptions ARE the discovery contract, so they cannot be trimmed.
 *
 * The default surface advertises 18 of 48 tools and trims every description to its first sentence,
 * which is the right trade for a real tool: the agent can see the name, and load the rest on demand.
 * It is exactly the wrong trade for `reticle_tools` and `reticle_run`, because the sentences being
 * cut are the ONLY place an agent is ever told that the other 30 tools exist or how to reach them.
 * Trimmed, `reticle_tools` advertises as "Discover Reticle tools on demand." — which names no way to
 * list anything, so an agent has no reason to call it and the whole cold tail is invisible.
 *
 * This is not a new hazard, it is the same one moving. advertisedConfig already carried a comment
 * about the retired `dynamic` profile, where trimming the meta-tools would have left "the agent with
 * nothing left to learn the surface from". `default` is now the lean surface AND the one carrying
 * the meta-tools, so the exemption has to follow.
 *
 * Asserted on the ADVERTISED text rather than on the tool definition, because the definition is
 * trimmed later — a guard that reads the raw def would pass with the bug fully present, a mistake
 * this file's neighbours have already made once.
 */

import { describe, expect, it } from 'vitest';
import { advertisedConfig } from '../mcp/mcp.js';
import { advertisedTools } from '../mcp/mcp.js';
import { TOOL_SURFACE, type ToolSurface } from './tool-surface.js';
import { ReticleTool } from './tool-names.js';

function advertised(name: string, surface: ToolSurface): string {
  const tools = advertisedTools(surface);
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`${name} is not advertised on ${surface}`);
  return advertisedConfig(tool, tools, surface).description;
}

describe('the meta-tools stay self-explanatory on every surface', () => {
  for (const surface of Object.values(TOOL_SURFACE)) {
    it(`${surface}: reticle_tools says how to LIST every tool and how to load params`, () => {
      const text = advertised(ReticleTool.TOOLS, surface).toLowerCase();
      expect(text, 'must say a no-argument call lists everything').toMatch(
        /no argument|without argument|omit/,
      );
      expect(text, 'must name the parameter that loads full detail').toContain('names');
    });

    it(`${surface}: reticle_run says it invokes any tool by name`, () => {
      const text = advertised(ReticleTool.RUN, surface).toLowerCase();
      expect(text).toContain('tool');
      expect(text, 'must convey invoking by name').toMatch(/invoke|call|run/);
    });
  }

  /**
   * The point of the exemption, stated as a property rather than a length: a real tool still gets
   * trimmed on the default surface, so this is an exemption for two tools and not a quiet undoing
   * of the lean surface.
   */
  it('still trims ordinary tools on the default surface', () => {
    const tools = advertisedTools(TOOL_SURFACE.DEFAULT);
    const snapshot = tools.find((t) => t.name === ReticleTool.SNAPSHOT);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) return;
    const shown = advertisedConfig(snapshot, tools, TOOL_SURFACE.DEFAULT).description;
    expect(shown.length).toBeLessThan(snapshot.description.length);
  });
});
