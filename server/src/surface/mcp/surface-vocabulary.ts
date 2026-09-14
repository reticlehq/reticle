import { ReticleTool } from '@reticlehq/core';

/**
 * How to CALL each job, on whichever surface is live.
 *
 * The instructions are the first thing an agent reads, and they used to name tools in prose:
 * `reticle_snapshot`, `reticle_query`, `reticle_wait_for`, `reticle_run`. On the default surface
 * every one of those is real, so nothing ever went wrong — and nothing in the build could tell that
 * the sentence and the surface were two independent facts.
 *
 * MEASURED, on the nine-tool surface: the briefing named NINE tools that did not exist on it, and
 * `reticle_tools` catalogued 57 more that could not be called. Handed that, an agent tried a tool it
 * had been shown, failed, tried again, and then stopped using the product — 96 drive calls on the
 * default surface against 2, and 20 verdicts against 1. It fixed the bugs by reading source instead.
 * The run READ as a 28% token saving, because a product nobody uses is cheap.
 *
 * `surface-coherence.test.ts` exists to catch exactly this and did not: it checks the documents
 * against `CORE_TOOL_NAMES`, so it is blind to every surface but the default and passed green.
 *
 * So the names are DERIVED here from the advertised set, and the prose asks for a job rather than a
 * tool. A briefing that names a tool the agent was not given is now unrepresentable rather than
 * merely tested for.
 */
export interface SurfaceVocabulary {
  navigate: string;
  look: string;
  find: string;
  inspect: string;
  state: string;
  observe: string;
  network: string;
  console: string;
  assert: string;
  settle: string;
  sessions: string;
  actAndWait: string;
  act: string;
  /** `reticle_session {action:"yield"}`, or empty where the surface has no session tool. */
  yield: string;
  feedback: string;
  /** The discovery sentence, or empty when this surface advertises everything it can call. */
  coldTail: string;
}

/** `reticle_look { action: "find" }` when the family is merged, `reticle_query` when it is not. */
function callOf(
  advertised: ReadonlySet<string>,
  direct: string,
  parent: string,
  action: string,
): string {
  if (advertised.has(direct)) return direct;
  if (advertised.has(parent)) return `${parent} {action:"${action}"}`;
  // Neither is advertised. Say nothing rather than name a tool the agent cannot call — an empty
  // slot costs a capability the agent has to discover; a wrong name costs the whole product.
  return '';
}

/** Drop the empty slots, so a sentence never reads "look (), find ()". */
export function listOf(...calls: readonly string[]): string {
  return calls.filter((call) => call.length > 0).join(' / ');
}

export function surfaceVocabulary(advertisedNames: readonly string[]): SurfaceVocabulary {
  const advertised = new Set(advertisedNames);
  const call = (direct: string, parent: string, action: string): string =>
    callOf(advertised, direct, parent, action);
  return {
    navigate: call(ReticleTool.NAVIGATE, ReticleTool.NAVIGATE, 'go'),
    look: call(ReticleTool.SNAPSHOT, ReticleTool.LOOK, 'page'),
    find: call(ReticleTool.QUERY, ReticleTool.LOOK, 'find'),
    inspect: call(ReticleTool.INSPECT, ReticleTool.LOOK, 'element'),
    state: call(ReticleTool.STATE, ReticleTool.LOOK, 'state'),
    observe: call(ReticleTool.OBSERVE, ReticleTool.OBSERVE, 'events'),
    network: call(ReticleTool.NETWORK, ReticleTool.OBSERVE, 'network'),
    console: call(ReticleTool.CONSOLE, ReticleTool.OBSERVE, 'console'),
    assert: call(ReticleTool.ASSERT, ReticleTool.ASSERT, 'now'),
    settle: call(ReticleTool.WAIT_FOR, ReticleTool.ASSERT, 'wait'),
    sessions: call(ReticleTool.SESSIONS, ReticleTool.SESSION, 'list'),
    actAndWait: ReticleTool.ACT_AND_WAIT,
    act: advertised.has(ReticleTool.ACT) ? ReticleTool.ACT : '',
    yield: advertised.has(ReticleTool.SESSION) ? `${ReticleTool.SESSION} {action:"yield"}` : '',
    feedback: call(ReticleTool.FEEDBACK, ReticleTool.SESSION, 'feedback'),
    // Only said when it is TRUE. `reticle_tools` without `reticle_run` is a catalogue of names
    // nothing can invoke, which is the trap this whole module was written after.
    coldTail:
      advertised.has(ReticleTool.TOOLS) && advertised.has(ReticleTool.RUN)
        ? `Everything else is one hop: ${ReticleTool.TOOLS} lists it, ${ReticleTool.RUN} calls it.`
        : '',
  };
}
