/**
 * The live adapter: build a RunnerPort from the real ToolDeps so ReticleRunner drives actual flow
 * replays against the connected app. Thin glue — it wires the session's flow list, replayNamedFlow, deps.now,
 * and a uuid generator. The ReticleRunner core (tested with a fake port) holds all the orchestration and
 * verdict logic, so this layer carries no decisions.
 */

import { ReplayStatus } from '@reticlehq/core';
import { replayAndLearn } from '@/language/flows/flow-learning.js';
import { sessionUrlOf } from '@/language/flows/flow-lease.js';
import { flowStartState } from '@/surface/tools/session-ports.js';
import { flowsForSession } from '@/language/flows/flow-store-for-session.js';
import { safeSessionTarget } from '@/memory/project/session-root.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import type { RunnerPort } from './reticle-runner.js';
import { defaultRunId } from './default-run-id.js';
export { defaultRunId } from './default-run-id.js';

/** Wire a RunnerPort to the live session. Pass sessionId to disambiguate when several tabs are open. */
export function createRunnerPort(
  deps: ToolDeps,
  sessionId?: string,
  /** `reticle verify --confirm-dangerous`: this run acknowledges the steps held as destructive. */
  opts: { confirmDangerous?: boolean; requireStartControl?: boolean; sweep?: boolean } = {},
): RunnerPort {
  // Each flow starts from the state the run started in, so one that signs out cannot fail the rest.
  const startState = flowStartState(deps.realInput, () => sessionUrlOf(deps, sessionId));
  return {
    // Resolved as replay resolves it, so every listed name is one replay can load.
    listFlows: () => {
      const target = safeSessionTarget(deps, sessionId);
      return flowsForSession(deps, target).flows.list(target.projectId);
    },
    replayFlow: async (name) => {
      const cannotStart = await startState();
      if (cannotStart !== undefined) {
        return {
          name,
          status: ReplayStatus.UNVERIFIABLE,
          steps: [],
          unverifiable: { reason: cannotStart },
        };
      }
      return await replayAndLearn(deps, {
        flowName: name,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(true === opts.confirmDangerous ? { confirmDangerous: true } : {}),
        ...(true === opts.requireStartControl ? { requireStartControl: true } : {}),
        ...(true === opts.sweep ? { sweep: true } : {}),
      });
    },
    now: () => deps.now(),
    newRunId: defaultRunId,
  };
}
