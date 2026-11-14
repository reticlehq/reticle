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

/**
 * How long a flow's end waits for a session to come back. A page of the app reconnects in well
 * under this ceiling. A page with no SDK never does. It is a ceiling, not a delay. It is not the
 * wait after the app is opened again: the next flow's replay waits for its own start page.
 */
const SESSION_BACK_TIMEOUT_MS = 5000;
const SESSION_POLL_MS = 25;

/**
 * Is the session this run drives connected? A read-only check. resolve() is not used: it marks
 * agent activity, and with no sessionId it also refuses when several tabs are connected and none is
 * the clear choice. Neither of those is a lost session. With an id, the check looks for that tab or
 * the session it connected again as. With no id, any connected tab in the project counts.
 */
function sessionConnected(deps: ToolDeps, sessionId: string | undefined): boolean {
  if (sessionId === undefined) {
    return 0 < deps.sessions.inScope().length;
  }
  return (
    deps.sessions.get(sessionId) !== undefined || deps.sessions.successorId(sessionId) !== undefined
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wire a RunnerPort to the live session. Pass sessionId to disambiguate when several tabs are open. */
export function createRunnerPort(
  deps: ToolDeps,
  sessionId?: string,
  /** `reticle verify --confirm-dangerous`: this run acknowledges the steps held as destructive. */
  opts: { confirmDangerous?: boolean; requireStartControl?: boolean; sweep?: boolean } = {},
): RunnerPort {
  const sessionBack = async (): Promise<boolean> => {
    const start = deps.now();
    while (!sessionConnected(deps, sessionId)) {
      if (deps.now() - start >= SESSION_BACK_TIMEOUT_MS) {
        return false;
      }
      await sleep(SESSION_POLL_MS);
    }
    return true;
  };
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
    sessionLost: async () => {
      if (await sessionBack()) {
        return undefined;
      }
      const lastUrl = deps.realInput?.pageUrl?.();
      return lastUrl === undefined ? {} : { lastUrl };
    },
    // Only the page load. A session that connects late is the next flow's start-page wait (#2155).
    reopen: async () => {
      await deps.realInput?.reopen?.();
    },
    now: () => deps.now(),
    newRunId: defaultRunId,
  };
}
