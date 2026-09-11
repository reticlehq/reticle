/**
 * Refuse to save a flow with no steps.
 *
 * It used to succeed: `flow_save` returned `{ stepCount: 0, grade: "assertion-free" }` with no error,
 * `flow_list` then showed one more flow, and `flow_verify` called it `unverifiable` — forever. The
 * agent believes it saved a regression test; what it wrote is a permanent suite entry that can never
 * go green or red.
 *
 * Zero steps is not a degraded flow, it is the absence of one. And the refusal matters most on the
 * stacks where the recorder is known to capture nothing, because there the empty save is the only
 * signal the agent would ever get that something went wrong.
 */
import { ReticleTool } from '../tools/tool-names.js';

interface EmptyFlowRefusal {
  error: string;
  recovery: string;
}

export function emptyFlowRefusal(stepCount: number, name: string): EmptyFlowRefusal | undefined {
  if (stepCount > 0) return undefined;
  return {
    error: `'${name}' has no steps, so there is nothing to save — a flow with no steps can never pass or fail, and would sit in the suite reporting "unverifiable" forever`,
    recovery:
      `Nothing was captured between ${ReticleTool.RECORD} { action: "start" } and { action: "stop" }. ` +
      `Drive at least one action with ${ReticleTool.ACT} or ${ReticleTool.ACT_AND_WAIT} while the ` +
      `recording is open, then save. If you DID act and this still says zero, the recorder captured ` +
      `nothing for this stack — report it with ${ReticleTool.FEEDBACK}.`,
  };
}
