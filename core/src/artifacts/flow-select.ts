/**
 * Which flows a run replays, and which it refused to.
 *
 * Two jobs that must stay distinguishable in the answer. SELECTION is what the caller asked for.
 * EXCLUSION is what the suite declined to run despite being asked. A run that silently returns fewer
 * flows than were selected is a run whose coverage nobody can account for — so anything held back
 * comes back NAMED, never subtracted.
 *
 * The same reasoning applies to a selection that matched nothing. Quietly passing over a typo is how
 * "all green" comes to mean "nothing ran", which is the failure this product exists to prevent
 * wearing a different hat.
 *
 * Pure: flows and a selection in, three lists out. No store, no clock, no IO.
 */

import { isQuarantined, type FlowFile } from './flow-types.js';

export interface FlowSelection {
  /** Run flows carrying ANY of these labels. A set is the union of what you named, not the overlap. */
  labels?: readonly string[];
  /** Run exactly these flows, by name. */
  names?: readonly string[];
}

export interface SelectedFlows {
  /** What will actually replay, in the order given. */
  run: FlowFile[];
  /** Held back by a justified quarantine, named so the verdict can report them. */
  quarantined: string[];
  /** Labels and names that matched nothing — a typo, or a set that no longer exists. */
  unmatched: string[];
}

export function selectFlows(flows: readonly FlowFile[], selection: FlowSelection): SelectedFlows {
  const wantedLabels = selection.labels ?? [];
  const wantedNames = selection.names ?? [];
  const asked =
    0 === wantedLabels.length && 0 === wantedNames.length
      ? [...flows]
      : flows.filter(
          (flow) =>
            wantedNames.includes(flow.name) ||
            (flow.labels ?? []).some((label) => wantedLabels.includes(label)),
        );

  // Quarantine is applied AFTER selection, so asking for a label a held flow carries cannot drag it
  // back in — and so the held one is reportable as "you asked for this and we did not run it".
  const run = asked.filter((flow) => !isQuarantined(flow));
  const quarantined = asked.filter((flow) => isQuarantined(flow)).map((flow) => flow.name);

  const unmatched = [
    ...wantedNames.filter((name) => !flows.some((flow) => flow.name === name)),
    ...wantedLabels.filter((label) => !flows.some((flow) => (flow.labels ?? []).includes(label))),
  ];

  return { run, quarantined, unmatched };
}
