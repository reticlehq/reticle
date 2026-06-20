/**
 * The live adapter: build a RunnerPort from the real ToolDeps so IrisRunner drives actual flow
 * replays against the connected app. Thin glue — it wires deps.flows.list, replayNamedFlow, deps.now,
 * and a uuid generator. The IrisRunner core (tested with a fake port) holds all the orchestration and
 * verdict logic, so this layer carries no decisions.
 */

import { randomUUID } from 'node:crypto';
import { asRunId, type RunId } from '@syrin/iris-protocol';
import { replayNamedFlow } from '../flows/flow-tools.js';
import type { ToolDeps } from '../tools/tools.js';
import type { RunnerPort } from './iris-runner.js';

/** The default run-id generator — a branded uuid. Isolated so it can be swapped/tested independently. */
export function defaultRunId(): RunId {
  return asRunId(randomUUID());
}

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
