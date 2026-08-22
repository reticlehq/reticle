import { z } from 'zod';
import { coverageRegressed, observabilityOf } from '../honesty/observability.js';
import { ReticleCommand, SnapshotMode } from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import type { ToolDef, ToolDeps } from './tools.js';
import { asString } from './tools-helpers.js';
import { exercisedCount } from './coverage-identity.js';
import { commandOrThrow, sessionIdShape } from './tool-kit.js';

/**
 * `reticle_coverage` — which interactive controls this session has driven, and which it has not.
 *
 * Every other read here answers a question the agent already thought to ask, which bounds
 * verification by the agent's imagination — the documented weak link. This answers the one question
 * that tells the agent whether to STOP: an agent that exercised 4 of 17 controls and believes it
 * verified the page is exactly the confident-and-wrong case Reticle exists to prevent, and nothing
 * in the tool surface previously contradicted it.
 *
 * Note this is NOT the existing `blindSpots` coverage, which is about what the layer could not SEE
 * (closed shadow roots, cross-origin frames). This is about what the agent did not TOUCH. Both are
 * honesty signals; they answer different questions and neither substitutes for the other.
 *
 * Unadvertised by every profile: it costs nothing per turn and is reached through `reticle_run`.
 */

/** Refs as the snapshot tree spells them: `(ref=e12)`. The tree format is ours, so this is exact. */
const REF_IN_TREE = /\(ref=(e\d+)\)/g;

/** The label a tree line carries before its ref, e.g. `- button "Archive" (ref=e9)`. */
const LINE_WITH_REF = /^\s*-\s*(.+?)\s*\(ref=(e\d+)\)/;

interface Control {
  ref: string;
  label: string;
}

/** Parse the interactive snapshot into {ref,label} controls, preserving document order. */
export function parseControls(tree: string): Control[] {
  const controls: Control[] = [];
  const seen = new Set<string>();
  for (const line of tree.split('\n')) {
    const match = LINE_WITH_REF.exec(line);
    if (null === match) continue;
    const [, label, ref] = match;
    if (label === undefined || ref === undefined || seen.has(ref)) continue;
    seen.add(ref);
    controls.push({ ref, label });
  }
  // A ref can appear on a line this regex does not shape (nested formatting); count it regardless,
  // because under-reporting the denominator would overstate coverage — the one direction that lies.
  for (const match of tree.matchAll(REF_IN_TREE)) {
    const ref = match[1];
    if (ref !== undefined && !seen.has(ref)) {
      seen.add(ref);
      controls.push({ ref, label: '' });
    }
  }
  return controls;
}

export const COVERAGE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.COVERAGE,
    description:
      'Which interactive controls you have driven this session, and which you have NOT. Returns { total, exercised, untouched:[{ref,label}], alsoDroveGone? } over the controls currently on the page. Use it to decide whether verification is finished: an untouched list that still holds the controls your change affects means you are not done. This is about what you did not TOUCH — distinct from the `coverage` field on an action result, which reports what the layer could not SEE.',
    example: {},
    inputSchema: { ...sessionIdShape },
    outputSchema: {
      total: z.number(),
      exercised: z.number(),
      untouched: z.array(z.object({ ref: z.string(), label: z.string() })),
      alsoDroveGone: z
        .number()
        .optional()
        .describe(
          'Controls you drove that are no longer on the page — usually because the action SUCCEEDED and removed them (archive/delete/submit/navigate). Counted separately so `exercised: 0` never appears immediately after real work.',
        ),
      instrumentationGaps: z
        .array(z.unknown())
        .optional()
        .describe(
          'What this app still cannot tell Reticle, as of your most recent verdict — each entry is { kind, missing, cost, fix, source?, ref? }. These are not controls you skipped; they are checks this app CANNOT answer until it is instrumented, so driving the untouched list will not close them. Apply each `fix` and re-verify: the gap disappears from this list when the app can answer, and every later verdict on this app gets stronger. OMITTED when nothing is missing.',
        ),
      unproven: z
        .boolean()
        .optional()
        .describe(
          'True when verification is NOT finished for a reason driving more controls cannot fix — instrumentationGaps is non-empty. Present only when true, so its absence is not a claim.',
        ),
      observability: z
        .object({ driven: z.number(), observable: z.number(), percent: z.number().optional() })
        .optional()
        .describe(
          'Of the controls you DROVE, how many Reticle could fully observe. `untouched` above is work left for you; this is work left in the APP, and driving more controls does not move it. `percent` is OMITTED when nothing was driven, because 0/0 is not 100%.',
        ),
      observabilityRegressed: z
        .object({ was: z.number(), now: z.number() })
        .optional()
        .describe(
          'This project has previously reached a HIGHER observability than this run did. Usually means an assertion or an instrumented path was removed — the cheapest way to stop a gap firing is to stop asserting the thing that revealed it. Present only when a drop is real and the run was large enough to compare.',
        ),
    },
    handler: async (deps: ToolDeps, args) => {
      const sessionId = asString(args['sessionId']);
      const session = deps.sessions.resolve(sessionId);
      // INTERACTIVE mode is already the "controls only" view, so the denominator is the page's own
      // notion of what can be driven rather than a second, drifting definition maintained here.
      const result = await commandOrThrow(deps, sessionId, ReticleCommand.SNAPSHOT, {
        mode: SnapshotMode.INTERACTIVE,
      });
      const tree = asString((result as Record<string, unknown>)['tree']) ?? '';

      // Matched by ref AND by label — see coverage-identity. A ref dies with the next re-render, so
      // on a framework that replaces nodes this reported `exercised: 0` however much work was done.
      // `droveGone` keeps the other honesty: archive/delete/submit remove their own control, so a
      // drive that WORKED must not read as no coverage at all.
      const { exercised, droveGone, untouched } = exercisedCount(
        parseControls(tree),
        session.actedRefs(),
        session.actedLabels(),
      );
      // The other half of "am I done?". `untouched` answers what you did not DRIVE; this answers
      // what this app cannot ANSWER, which no amount of further driving will change. Reporting the
      // first without the second is how an agent finishes a pass believing it verified something the
      // app was never able to confirm.
      const gaps = session.gaps?.open() ?? [];
      // The number, and the floor under it, together. A coverage figure that can only ever be
      // reported and never contradicted is one an agent learns to satisfy rather than to earn.
      const observability = observabilityOf(session.actedRefs(), gaps);
      const best = await deps.project.bestObservability();
      const regressed = coverageRegressed(best, observability);
      if (observability.percent !== undefined) {
        await deps.project.raiseObservability(observability.percent);
      }
      return {
        total: parseControls(tree).length,
        exercised,
        untouched,
        ...(droveGone > 0 ? { alsoDroveGone: droveGone } : {}),
        ...(gaps.length > 0 ? { instrumentationGaps: gaps, unproven: true } : {}),
        observability,
        ...(regressed === undefined ? {} : { observabilityRegressed: regressed }),
      };
    },
  },
];
