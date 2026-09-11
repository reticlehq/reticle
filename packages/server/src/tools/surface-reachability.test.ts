import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { TOOL_SURFACE, filterTools, type ToolSurface } from './tool-surface.js';
import { advertisedTools } from '../mcp/mcp.js';

/**
 * Under every profile, a tool named in another tool's description must be REACHABLE.
 *
 * `standard` hard-filtered the surface with no meta-tools appended, so 11 tools were not merely
 * un-advertised — they could not be called at all. The sharpest instance was self-contradicting:
 * `reticle_flow_save`'s description tells the agent to "add a consequence assertion via
 * reticle_annotate", and `reticle_annotate` was not in `standard`. A user who set that profile on our
 * own advice got an agent instructed to call a tool that did not exist for it.
 *
 * The fix is that every trimmed profile keeps the meta-tools (reticle_tools / reticle_run) as an escape
 * hatch. These tests pin both halves: the hatch is present wherever the surface is trimmed, and no
 * description points at something unreachable.
 */

/** Profiles that advertise a reduced surface and therefore need an escape hatch. */
const TRIMMED: ToolSurface[] = [TOOL_SURFACE.DEFAULT];

/** Names an agent can invoke under a profile: advertised directly, or via the meta-tools. */
/**
 * Names an agent can invoke under a profile.
 *
 * Derived from the REAL `advertisedTools`, not re-implemented. The previous version unioned in every
 * tool unconditionally, so it was insensitive to `profile` and would have stayed green if the escape
 * hatch were removed — a guard that cannot fail. The hatch is what makes an un-advertised tool
 * reachable, so its presence is exactly what must be checked.
 */
function reachable(profile: ToolSurface): Set<string> {
  const advertised = advertisedTools(profile);
  const names = advertised.map((t) => t.name);
  const hasHatch = names.includes(ReticleTool.RUN);
  // With reticle_run advertised, everything in TOOLS is callable through the same chokepoint.
  return new Set(hasHatch ? [...names, ...TOOLS.map((t) => t.name)] : names);
}

const ALL_NAMES = new Set(Object.values(ReticleTool));

describe('tool reachability across profiles', () => {
  it('every trimmed profile ADVERTISES the escape hatch — without it a trim is a hard removal', () => {
    for (const profile of TRIMMED) {
      const names = advertisedTools(profile).map((t) => t.name);
      expect(names, `profile '${profile}' must advertise ${ReticleTool.RUN}`).toContain(
        ReticleTool.RUN,
      );
      expect(names).toContain(ReticleTool.TOOLS);
    }
  });

  it('a trimmed profile advertises FEWER tools than full, or the trim buys nothing', () => {
    for (const profile of TRIMMED) {
      expect(advertisedTools(profile).length).toBeLessThan(
        advertisedTools(TOOL_SURFACE.ALL).length,
      );
    }
  });

  for (const profile of TRIMMED) {
    it(`no advertised description under '${profile}' names an unreachable tool`, () => {
      const canCall = reachable(profile);
      const offenders: string[] = [];
      for (const tool of filterTools(TOOLS, profile)) {
        // Every reticle_* token mentioned in this tool's description.
        for (const mentioned of tool.description.match(/reticle_[a-z_]+/g) ?? []) {
          if (!ALL_NAMES.has(mentioned as ReticleTool)) continue; // prose, not a real tool name
          if (!canCall.has(mentioned)) offenders.push(`${tool.name} -> ${mentioned}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('a trimmed profile advertises fewer tools than full — otherwise the trim is pointless', () => {
    expect(filterTools(TOOLS, TOOL_SURFACE.DEFAULT).length).toBeLessThan(TOOLS.length);
  });
});
