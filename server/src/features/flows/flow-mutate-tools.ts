/**
 * The question that grades the FLOW rather than the app: would it notice if the thing it depends on
 * broke?
 *
 * Every decision behind the answer was made and tested apart — the target comes from what the flow
 * itself declared, the loop guarantees the page is put back, and the grade refuses to count what it
 * did not establish. This is the call that joins them, and its own job is mostly knowing when to
 * answer NOTHING.
 *
 * Both refusals below produce no outcome on purpose. A mutation score that reports a demotion it did
 * not measure is worse than one that reports less: it is a number arguing to delete good tests.
 */

import { mutationTargetsFor, ReticleTool, asString, type FlowFile } from '@reticlehq/core';
import { MutationOutcome } from '@reticlehq/openreality';
import { z } from 'zod';
import { sessionMutationPort } from '../../agent/tools/lease-tools.js';
import { mutationTest } from './mutation-run.js';
import { replayNamedFlow, sessionProjectId } from './flow-replay-run.js';
import { flowsForSession } from './flow-store-for-session.js';
import type { ToolDef, ToolDeps } from '../../agent/tools/tools.js';
import { ReplayStatus } from '@reticlehq/core';

const NOTHING_DECLARED =
  'this flow declares no network consequence, so it has named nothing whose breakage it could be ' +
  'expected to notice. Breaking something it never claimed to depend on would manufacture a ' +
  'demotion rather than measure one. Give a step an `expect: { net: { urlContains } }`, or set the ' +
  "flow's `success` to a net consequence, and it becomes mutation-testable.";

const NEEDS_A_DRIVEN_PAGE =
  'nothing here can break the page: mutation needs a DRIVEN browser (`reticle drive` / ' +
  'RETICLE_CDP_URL). An attached tab cannot be perturbed from inside itself, and reporting ' +
  '"survived" without applying anything would demote every flow on every project that has not driven.';

export const FLOW_MUTATE_TOOL: ToolDef = {
  name: ReticleTool.FLOW_MUTATE,
  description:
    'Does this flow NOTICE when the thing it depends on breaks? Replays it, fails the endpoint the flow itself declared it needs, replays it again, and grades the FLOW: "killed" (it went red — it is a real test), "survived" (it stayed green through a broken subject — it is a click sequence, not a test), or "inconclusive" (nothing was established, and it says which). The page is always put back, including when a replay throws. DESTRUCTIVE: really breaks a request on a driven page for the duration.',
  inputSchema: {
    flowName: z
      .string()
      .optional()
      .describe('Flow file name (without .json), from reticle_flow{action:"list"}.'),
    // The same thing under the other name this surface already uses. Both, because an agent that
    // learned `flow` from reticle_annotate must not be refused here — see surface-consistency.
    flow: z.string().optional().describe('Alias for `flowName`.'),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    flow: z.string(),
    /** Absent when nothing was established — `because` then says why, and it is never a demotion. */
    outcome: z.string().optional(),
    target: z.string().optional(),
    because: z.string(),
  },
  handler: async (deps: ToolDeps, args): Promise<Record<string, unknown>> => {
    const name = asString(args['flowName']) ?? asString(args['flow']) ?? '';
    const sessionId = asString(args['sessionId']);
    const projectId = sessionProjectId(deps, sessionId);
    const loaded = await flowsForSession(deps, projectId).flows.load(name, projectId);
    if (!loaded.ok) {
      return { flow: name, because: `could not load "${name}": ${String(loaded.code)}` };
    }
    const flow: FlowFile = loaded.value;

    const target = mutationTargetsFor(flow)[0];
    if (target === undefined) return { flow: name, because: NOTHING_DECLARED };

    const port = await sessionMutationPort(deps.realInput, deps.sessions.resolve(sessionId)?.url);
    if (port === undefined) return { flow: name, target, because: NEEDS_A_DRIVEN_PAGE };

    const outcome = await mutationTest(
      {
        replay: async () => {
          const result = await replayNamedFlow(deps, { flowName: name, sessionId });
          return ReplayStatus.OK === result.status ? 'pass' : 'fail';
        },
        mutate: (mutation) => port.mutate(mutation),
        revert: () => port.revert(),
      },
      { kind: 'request-fails', target },
    );
    return { flow: name, target, outcome, because: becauseOf(outcome, target) };
  },
};

function becauseOf(outcome: MutationOutcome, target: string): string {
  if (MutationOutcome.KILLED === outcome) {
    return `the flow went red when ${target} failed — it is testing what it appears to test`;
  }
  if (MutationOutcome.SURVIVED === outcome) {
    return `the flow stayed GREEN while ${target} failed, which it declared it depends on. It is not a test, it is a click sequence — give the step that calls ${target} an \`expect\` naming the consequence it causes`;
  }
  return `nothing was established about this flow: it was already failing, the break could not be applied, or a replay did not finish. The page was put back either way`;
}
