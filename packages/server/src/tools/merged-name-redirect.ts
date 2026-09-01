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
 * DERIVED from `MERGE_PLANS` and `RETIRED_FROM_SURFACE` rather than written out, so the next merge is
 * covered the day it lands instead of the day someone notices.
 */
import { MERGE_PLANS, RETIRED_FROM_SURFACE } from './tools.js';
import { ReticleTool } from './tool-names.js';

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
  for (const plan of MERGE_PLANS) {
    for (const [action, oldName] of Object.entries(plan.members)) {
      map.set(oldName, { tool: plan.name, action });
    }
  }
  for (const name of RETIRED_FROM_SURFACE) {
    const known = RETIRED_NOTE[name];
    if (known !== undefined) map.set(name, known);
  }
  return map;
})();

/** Every old name and where it went, for a catalog that has to carry the migration itself. */
export function mergedNameRedirects(): ReadonlyArray<readonly [string, MergedNameRedirect]> {
  return [...BY_OLD_NAME.entries()];
}

/** Where `name` went, or undefined when it is a live tool or not ours. */
export function mergedNameRedirect(name: string): MergedNameRedirect | undefined {
  return BY_OLD_NAME.get(name);
}

/** The sentence handed to an agent that called `name`. */
export function mergedNameMessage(name: string, redirect: MergedNameRedirect): string {
  return redirect.action === undefined
    ? `${name} no longer exists — ${redirect.note ?? `use ${redirect.tool}`}.`
    : `${name} was merged into ${redirect.tool}. Call ${redirect.tool} { action: "${redirect.action}", ... } — ` +
        `through reticle_run if it is not advertised under this profile.`;
}
