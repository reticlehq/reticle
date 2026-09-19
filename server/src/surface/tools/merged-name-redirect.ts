/**
 * Where a merged or retired tool's old name went.
 *
 * Twenty-two names exported from `ReticleTool` are no longer tools: `reticle_record_start` became
 * `reticle_record { action: "start" }`, `reticle_diff` became `reticle_baseline { action: "diff" }`,
 * and three were retired outright. Confirmed live in a field sweep, they all answered `unknown tool`
 * — which is the wrong answer, because the capability exists and only moved. An agent trained on an
 * earlier release, or reading the merged tool's own description (which names every action), reaches
 * for exactly these.
 *
 * DERIVED from `MERGE_PLANS`, `MERGED_SURFACE_PLANS` and `RETIRED_FROM_SURFACE` rather than written out, so the next merge is
 * covered the day it lands instead of the day someone notices.
 */
import { MERGE_PLANS, MERGED_SURFACE_PLANS, RETIRED_FROM_SURFACE } from './tools.js';
import { ReticleTool } from '@reticlehq/core';
import { TOOL_REACH, hatchCall, noRouteAdvice, type ToolReach } from './tool-reach.js';

interface MergedNameRedirect {
  /** The tool to call instead. */
  tool: string;
  /** The action that selects the old behaviour, when the name was merged rather than retired. */
  action?: string;
  /** Why there is no direct replacement, for a retired name. */
  note?: string;
}

/** Retired names, and where the capability actually lives now. */
const RETIRED_NOTE: Readonly<Record<string, MergedNameRedirect>> = {
  [ReticleTool.REFRESH]: {
    tool: ReticleTool.NAVIGATE,
    note: 'reloading was absorbed into reticle_navigate { reload: true }',
  },
  [ReticleTool.RUN_RECORD]: {
    tool: ReticleTool.PROJECT,
    note: 'run outcomes are persisted automatically by reticle_flow_replay; read them with reticle_project',
  },
  [ReticleTool.WAIT_READY]: {
    tool: ReticleTool.SESSIONS,
    note: 'waiting is implicit — the first live call already blocks until the session is ready',
  },
};

const BY_OLD_NAME = ((): ReadonlyMap<string, MergedNameRedirect> => {
  const map = new Map<string, MergedNameRedirect>();
  // BOTH plan lists. This read `MERGE_PLANS` alone, and the surface merges — the ones that fold
  // snapshot/query/inspect/state into `reticle_look` and network/console into `reticle_observe` —
  // live in their own list. So on the surface where those names are ACTUALLY gone, the redirect knew
  // nothing about them and the SDK answered `Tool reticle_snapshot not found`: the exact "this tool
  // does not exist" that this whole file exists to stop an agent believing. Two hand-maintained
  // lists that had to agree, and the one nobody updated was the one the reader hit.
  for (const plan of [...MERGE_PLANS, ...MERGED_SURFACE_PLANS]) {
    for (const [action, oldName] of Object.entries(plan.members)) {
      map.set(oldName, { tool: plan.name, action });
    }
  }
  for (const name of RETIRED_FROM_SURFACE) {
    const known = RETIRED_NOTE[name];
    if (known !== undefined) map.set(name, known);
  }
  // The one merge no plan can describe. `reticle_act` absorbs `reticle_act_sequence` by the SHAPE of
  // the call — a `steps` array — rather than by an `action`, because `act` already owns that
  // parameter name (see act-merged.ts). Having no plan entry, it had no tombstone either, and was
  // the last merged name still answering "not found" after every other one had a redirect. Set here
  // rather than in RETIRED_NOTE because it is not retired: it is merged, and the distinction is what
  // the reader needs.
  map.set(ReticleTool.ACT_SEQUENCE, {
    tool: ReticleTool.ACT,
    note: 'a sequence is now reticle_act { steps: [...] } — the same call, routed on the steps array',
  });
  return map;
})();

/** Where `name` went, or undefined when it is a live tool or not ours. */
export function mergedNameRedirect(name: string): MergedNameRedirect | undefined {
  return BY_OLD_NAME.get(name);
}

/**
 * Every retired name against the call that replaces it — the tombstones, as one block.
 *
 * The redirect above answers an agent that already guessed the old name. This answers the one that
 * is reading the surface to find out what exists, and is the case a redirect cannot reach: nothing
 * in the catalogue says `reticle_crawl` became `reticle_verify { action: "crawl" }`, so instructions
 * written against an earlier release lead either to an error string or to nothing at all.
 *
 * Derived from the same two declarations as `BY_OLD_NAME`, for the same reason: a hand-written
 * migration list is one merge away from being wrong, and wrong is worse than absent here — the agent
 * retries into it.
 */
export function retiredToolNames(): Readonly<Record<string, string>> {
  const tombstones: Record<string, string> = {};
  for (const [old, redirect] of BY_OLD_NAME) {
    tombstones[old] =
      redirect.action === undefined
        ? `retired; ${redirect.note ?? `use ${redirect.tool}`}`
        : `retired; use ${redirect.tool} { action: "${redirect.action}" }`;
  }
  return tombstones;
}

/** The sentence handed to an agent that called `name`. */
export function mergedNameMessage(
  name: string,
  redirect: MergedNameRedirect,
  /**
   * How THIS surface reaches the tool it moved into, from `toolReach`.
   *
   * REQUIRED, and that is the correction. It was an optional boolean — "is the target advertised?"
   * — which is a two-state answer to a three-state question, so every caller that did not know, and
   * the one that knew only half, fell through to a sentence asserting a dispatch hatch. On the
   * default surface there is none, so the message whose entire job is to stop an agent concluding
   * "this does not exist" named a tool that does not exist (#978). Not answering is now a type
   * error rather than a wrong sentence.
   */
  reach: ToolReach,
): string {
  if (redirect.action === undefined) {
    return `${name} no longer exists — ${redirect.note ?? `use ${redirect.tool}`}.`;
  }
  const call = `Call ${redirect.tool} { action: "${redirect.action}", ... }`;
  if (TOOL_REACH.DIRECT === reach) return `${name} was merged into ${redirect.tool}. ${call}.`;
  if (TOOL_REACH.HATCH === reach) {
    // The hedge is deliberate and stays: a caller reading a catalogue knows its surface ships the
    // hatch without necessarily knowing whether THIS target is advertised, and both routes work
    // there. What changed is only that the sentence is no longer produced where neither does.
    return (
      `${name} was merged into ${redirect.tool}. ${call} — or ` +
      `${hatchCall(redirect.tool, `{ action: "${redirect.action}", ... }`)} if ${redirect.tool} ` +
      `is not advertised under this profile.`
    );
  }
  // Leading with "Call …" would be the same defect one level in: the call is unreachable here too.
  return (
    `${name} was merged into ${redirect.tool} { action: "${redirect.action}" }. ` +
    noRouteAdvice(redirect.tool)
  );
}
