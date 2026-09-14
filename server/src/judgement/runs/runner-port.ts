/**
 * The live adapter: build a RunnerPort from the real ToolDeps so ReticleRunner drives actual flow
 * replays against the connected app. Thin glue — it wires deps.flows.list, replayNamedFlow, deps.now,
 * and a uuid generator. The ReticleRunner core (tested with a fake port) holds all the orchestration and
 * verdict logic, so this layer carries no decisions.
 */

import { replayNamedFlow } from '../../language/flows/flow-tools.js';
import type { ToolDeps } from '../../surface/tools/tool-kit.js';
import type { RunnerPort } from './reticle-runner.js';
import { defaultRunId } from './default-run-id.js';
export { defaultRunId } from './default-run-id.js';

/** Wire a RunnerPort to the live session. Pass sessionId to disambiguate when several tabs are open. */
export function createRunnerPort(deps: ToolDeps, sessionId?: string): RunnerPort {
  return {
    listFlows: () => deps.flows.list(),
    replayFlow: (name) =>
      replayNamedFlow(
        deps,
        sessionId !== undefined ? { flowName: name, sessionId } : { flowName: name },
      ),
    now: () => deps.now(),
    newRunId: defaultRunId,
  };
}
