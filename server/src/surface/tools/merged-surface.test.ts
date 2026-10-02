import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { TOOL_SURFACE, EXTENDED_TOOL_NAMES } from './tool-surface.js';
import { advertisedTools } from '@/surface/mcp/mcp.js';
import { SURFACE_MERGE_PLANS, MERGED_TOOLS, TOOLS } from './tools.js';

/**
 * The `merged` surface must LOSE NOTHING. Twice while it was being built, it did.
 *
 * First: `reticle_look` was absent from the surface allowlist, so `filterTools` — which matches by
 * NAME and says nothing when a name is unknown — dropped it. The four tools it consumed were gone,
 * the replacement never appeared, and the surface measured 32% cheaper. That is not a saving, it is
 * four capabilities deleted, and the only symptom was a better number.
 *
 * Second: the surface was missing from the `lean` branch in `advertisedConfig`, so it served full
 * prose plus output schemas and measured 2.4x MORE expensive than the default it was meant to trim.
 *
 * Both were invisible except by reading the tool list. So the list is asserted here: what is
 * advertised, and that everything the default surface offers is still reachable under some name.
 */
const names = (surface: Parameters<typeof advertisedTools>[0]): Set<string> =>
  new Set(advertisedTools(surface).map((t) => t.name));

describe('the merged surface trims names, never capabilities', () => {
  it('advertises exactly ten tools', () => {
    expect([...names(TOOL_SURFACE.MERGED)].sort()).toEqual(
      [
        ReticleTool.LOOK,
        ReticleTool.NAVIGATE,
        ReticleTool.ACT,
        ReticleTool.ACT_AND_WAIT,
        ReticleTool.ASSERT,
        ReticleTool.OBSERVE,
        ReticleTool.VERIFY,
        ReticleTool.SESSION,
        // Both meta-tools. `reticle_tools` because a lean input schema needs somewhere to get full
        // parameters from, and recovery messages across the server name it by hand. `reticle_run`
        // because this surface does NOT advertise everything — see the test below.
        ReticleTool.TOOLS,
        ReticleTool.RUN,
      ].sort(),
    );
  });

  /**
   * It used to drop `reticle_run`, "because nothing is left for it to reach". That was false, and
   * had been for some time: `MERGED_TOOL_NAMES` excludes every name in `EXTENDED_TOOL_NAMES`, so
   * eleven registered tools were advertised by nothing, callable by nothing and catalogued by
   * nothing — `reticle_tools { names: ['reticle_screenshot'] }` answered `unknown tool` on a build
   * where that tool exists. The extended set is demoted on the stated promise that each member is
   * "still one reticle_run hop away"; dropping the hatch cancelled the half of that trade we owed
   * the caller.
   *
   * This asserts the PROPERTY rather than the tool name, so it fails again the day something else
   * leaves the advertised set without a route back.
   */
  it('keeps reticle_run, because the surface does not advertise everything', () => {
    const merged = names(TOOL_SURFACE.MERGED);
    expect([...merged]).toContain(ReticleTool.RUN);

    const unadvertised = [...EXTENDED_TOOL_NAMES].filter((name) => !merged.has(name));
    expect(unadvertised.length).toBeGreaterThan(0);
    expect(unadvertised).toContain(ReticleTool.SCREENSHOT);
  });

  it('every tool the DEFAULT surface advertises is still reachable on merged', () => {
    const merged = names(TOOL_SURFACE.MERGED);
    const absorbed = new Map<string, string>();
    for (const plan of SURFACE_MERGE_PLANS) {
      for (const member of Object.values(plan.members)) absorbed.set(member, plan.name);
    }
    // Folded into the existing session plan, which lives in MERGE_PLANS rather than here so the
    // harness toolset keeps excluding `reticle_feedback` by name.
    absorbed.set(ReticleTool.SESSIONS, ReticleTool.SESSION);
    absorbed.set(ReticleTool.FEEDBACK, ReticleTool.SESSION);
    // Routed on the presence of `steps` rather than on an action name — see act-merged.ts.
    absorbed.set(ReticleTool.ACT_SEQUENCE, ReticleTool.ACT);
    // The dispatch hatch, deliberately gone: a surface that advertises everything has nothing to
    // dispatch TO. Asserted separately above so it cannot be mistaken for an oversight here.
    absorbed.set(ReticleTool.RUN, ReticleTool.TOOLS);

    const lost: string[] = [];
    for (const tool of advertisedTools(TOOL_SURFACE.DEFAULT)) {
      if (merged.has(tool.name)) continue;
      const into = absorbed.get(tool.name);
      if (into === undefined || !merged.has(into)) lost.push(tool.name);
    }
    expect(
      lost,
      'a default-surface tool that is neither advertised here nor absorbed by something that is ' +
        'has been silently deleted from this surface — which reads as a token saving',
    ).toEqual([]);
  });

  it('dispatches each merged action to the handler that always served it', () => {
    const look = MERGED_TOOLS.find((t) => t.name === ReticleTool.LOOK);
    expect(look, 'reticle_look must exist in the merged table').toBeDefined();
    // The action enum IS the discovery surface for a merged tool: the description is trimmed to its
    // first sentence on the wire, so an action missing here is an action nobody can find.
    const actions = look?.inputSchema['action'];
    expect(actions).toBeDefined();
    const plan = SURFACE_MERGE_PLANS.find((p) => p.name === ReticleTool.LOOK);
    expect(Object.keys(plan?.members ?? {}).sort()).toEqual(
      ['element', 'find', 'page', 'state'].sort(),
    );
    // Every member still exists as a real tool with a real handler — a merge must not invent one.
    for (const member of Object.values(plan?.members ?? {})) {
      expect(
        TOOLS.some((t) => t.name === member) || MERGED_TOOLS.some((t) => t.name === member),
        member,
      ).toBe(true);
    }
  });
});

/**
 * The first two moves an agent makes are ZERO-ARGUMENT: "is anything connected?" then "what is on
 * the page?". On the unmerged surface `reticle_sessions` and `reticle_snapshot` answer both.
 *
 * Merging turned them into `{action}` calls that refused a bare invocation. MEASURED, twice, on the
 * same five bugs: the merged arm made 0 drive calls and 0 verdict calls against 84 and 24, declared
 * 0 intents against 18, and produced a false green it reached in eight turns without ever opening
 * the app. It answered `unknown action 'undefined'` on the first move, concluded the app was not
 * wired, and fixed every bug by reading source. The second run — after the briefing was fixed —
 * reproduced it exactly, which is what ruled the briefing out and left this.
 *
 * A merged tool that cannot be called the way its members could is not a smaller surface. It is a
 * surface that refuses the only call an agent knows how to make first.
 */
describe('a bare call means the obvious thing', () => {
  const bare = async (name: string): Promise<unknown> => {
    const tool = advertisedTools(TOOL_SURFACE.MERGED).find((t) => t.name === name);
    expect(tool, `${name} must be advertised`).toBeDefined();
    // Empty deps: the handler is expected to REACH real work and fail there. What must not happen
    // is a dispatch refusal, which is a decision this layer makes before any handler is consulted.
    try {
      return await tool?.handler({} as never, {});
    } catch (err) {
      return { reachedHandler: true, err: String(err) };
    }
  };

  it.each([ReticleTool.LOOK, ReticleTool.OBSERVE, ReticleTool.ASSERT, ReticleTool.SESSION])(
    '%s answers a bare call instead of refusing it',
    async (name) => {
      const result = (await bare(name)) as { error?: string };
      expect(
        result.error ?? '',
        `${name} refused a zero-argument call — the first move an agent makes`,
      ).not.toMatch(/unknown action/);
    },
  );

  it('reticle_verify still refuses one, because one of its actions really clicks', async () => {
    const result = (await bare(ReticleTool.VERIFY)) as { error?: string };
    expect(
      result.error,
      'a default here would pick between reading the app and DRIVING it, and a wrong guess drives',
    ).toMatch(/unknown action/);
  });
});
