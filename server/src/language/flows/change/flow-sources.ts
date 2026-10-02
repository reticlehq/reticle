import type { FlowStep } from '@reticlehq/core';
import { affectedFlows, type AffectedResult, type FlowSources } from './affected.js';

/**
 * A flow's sources manifest, DERIVED from its already-persisted step anchors — no separate storage. A
 * COMPONENT anchor carries the source file its element was stamped from (via the babel/next plugin);
 * collecting those files, recursively through act_sequence sub-steps, gives the set of files whose change
 * should re-verify this flow. A flow with no stamped sources yields an empty manifest → unknown
 * provenance → always affected (fail-safe), handled by affectedFlows.
 */
export function flowSources(steps: readonly FlowStep[]): string[] {
  const files = new Set<string>();
  const walk = (list: readonly FlowStep[]): void => {
    for (const step of list) {
      /*
       * ANY anchor that carries a source, not only a COMPONENT one.
       *
       * This was `kind === COMPONENT && source !== undefined`, and the `kind` half was the whole
       * bug. `compileAnchorArgs` attaches the source to a TESTID anchor too — deliberately, with a
       * comment saying it rides along so a failure can name a file — so the data was already on
       * disk and simply never read. Measured on this repository's own saved flows: 32 of 40 carry
       * a source, and every one of them was reported as unknown-provenance.
       *
       * What that cost: `verify { action: "change" }` on two edited files replayed FIFTY-TWO flows
       * in 46 seconds and answered `unknown`, because the fail-safe re-runs everything it cannot
       * attribute. The fix needs no re-recording — those flows have been carrying the answer the
       * whole time.
       */
      const anchored = step.anchor as { source?: { file: string } };
      if (anchored.source !== undefined) files.add(anchored.source.file);
      /*
       * The step's own source, which is where almost every real flow's coverage actually lives.
       *
       * Only a COMPONENT anchor had somewhere to put one, and a recorder prefers a TESTID anchor
       * whenever the element has a testid — so the flows most likely to exist were exactly the ones
       * that could never say what they cover. Every one came back unknown-provenance and the
       * fail-safe re-ran the lot: measured against this repo's own saved flows, 52 replayed in 46
       * seconds to answer `unknown`.
       */
      if (step.source !== undefined) files.add(step.source.file);
      if (step.steps !== undefined) walk(step.steps);
    }
  };
  walk(steps);
  return [...files];
}

/** A saved flow, minimally: its name and steps. */
export interface NamedFlow {
  name: string;
  steps: readonly FlowStep[];
}

/** Map saved flows to the {name, sources} the affected index consumes, deriving each manifest. */
export function toFlowSources(flows: readonly NamedFlow[]): FlowSources[] {
  return flows.map((flow) => ({ name: flow.name, sources: flowSources(flow.steps) }));
}

/** Which saved flows a set of changed files affects — the derivation + index in one call. */
export function affectedSavedFlows(
  flows: readonly NamedFlow[],
  changedFiles: readonly string[],
): AffectedResult {
  return affectedFlows(toFlowSources(flows), changedFiles);
}
