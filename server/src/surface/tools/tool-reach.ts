/**
 * How a tool surface reaches a tool — the one question the advice strings used to assume.
 *
 * There are three answers and the code knew about two. A tool is either advertised (call it), or
 * unadvertised on a surface that ships `reticle_run` (dispatch to it), or unadvertised on a surface
 * that ships no hatch at all — where the honest answer is that nothing here can call it, and the
 * only route is the switch that starts the next daemon with a wider surface.
 *
 * The third answer is the default. `advertisedTools` drops `reticle_run` on the merged surface and
 * `reticle_tools` states plainly that "there is no hidden tail and no dispatch hatch to reach one",
 * yet three separate producers went on naming the hatch: the discovery reply for a merged name, the
 * unadvertised-tool help, and the merge redirect they both go through. Driven against a released
 * daemon, `reticle_tools { names: ["reticle_coverage"] }` answered "through reticle_run if it is not
 * advertised under this profile" — wrong twice in one clause, because the tool it named as the
 * fallback was gone and the tool it was redirecting to was advertised all along (#978).
 *
 * A wrong remedy costs more than no remedy: it gets followed, and the agent spends a turn learning
 * only that the recovery was fiction. So the question is asked HERE, against the live surface, and a
 * caller that does not answer it does not compile.
 */
import { ReticleTool } from '@reticlehq/core';
import { ADVERTISE_ALL_ENV } from './tool-surface.js';

export const TOOL_REACH = {
  /** Advertised here. Call it by name; there is nothing to explain. */
  DIRECT: 'direct',
  /** Not advertised, but this surface ships the dispatch hatch, so it is one `reticle_run` away. */
  HATCH: 'hatch',
  /** Not advertised and no hatch. Nothing on this surface can call it. */
  CLOSED: 'closed',
} as const;

export type ToolReach = (typeof TOOL_REACH)[keyof typeof TOOL_REACH];

/**
 * How `advertised` reaches `tool`.
 *
 * Keyed on the ADVERTISED set rather than on a surface name, because that is what the reader was
 * handed — a surface constant would have to be kept in step with `filterTools` by hand, and the two
 * lists drifting is the failure this whole area keeps repeating.
 */
export function toolReach(tool: string, advertised: ReadonlySet<string>): ToolReach {
  if (advertised.has(tool)) return TOOL_REACH.DIRECT;
  return advertised.has(ReticleTool.RUN) ? TOOL_REACH.HATCH : TOOL_REACH.CLOSED;
}

/** The `args` object when the caller still has to fill it in. */
const ARGS_PLACEHOLDER = '{ ... }';

/** The dispatch call that reaches `tool`, written out so it can be copied rather than composed. */
export function hatchCall(tool: string, args: string = ARGS_PLACEHOLDER): string {
  return `${ReticleTool.RUN} { tool: "${tool}", args: ${args} }`;
}

/**
 * What to say when the answer is "it does not": the switch, and what IS reachable meanwhile.
 *
 * It names no tool call on purpose. Every call this surface could offer is one the reader has
 * already been refused, and the whole defect here was offering one anyway — so the only pointer is
 * `reticle_tools`, which every surface advertises, and the env var, which is read by the DAEMON at
 * startup and therefore takes effect on the next one rather than on this call.
 */
export function noRouteAdvice(tool: string): string {
  return (
    `${tool} is not advertised on this tool surface and there is no dispatch tool here to route ` +
    `through, so nothing in this session can call it — that is a property of the surface, not a ` +
    `missing feature and not a retired name. Start the daemon with ${ADVERTISE_ALL_ENV}=1 to ` +
    `advertise it; the daemon reads that at startup, so it takes effect on the next one. Until ` +
    `then, ${ReticleTool.TOOLS} {} lists what this surface does advertise.`
  );
}
