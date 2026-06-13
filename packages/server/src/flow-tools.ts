import { z } from 'zod';
import {
  FLOW_SIGNAL_TIMEOUT_MS,
  FlowErrorCode,
  ReplayStatus,
  type FlowReplayResult,
} from '@iris/protocol';
import { IrisTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import { replayFlow } from './flow-replay.js';
import { waitForPredicate } from './predicate.js';
import type { ToolDef, ToolDeps } from './tools.js';

/** Map a structured FlowErrorCode to a legible one-line message for the agent. */
function flowErrorMessage(code: FlowErrorCode): string {
  switch (code) {
    case FlowErrorCode.INVALID_NAME:
      return 'invalid flow name — use a single safe segment (letters/digits/-/_), no path separators';
    case FlowErrorCode.NOT_FOUND:
      return 'no such flow on disk — run iris_flow_list to see saved flows';
    case FlowErrorCode.PARSE_FAILED:
      return 'flow file is malformed — fix or regenerate it with iris_flow_save';
    case FlowErrorCode.NO_RECORDING:
      return 'no compiled recording by that name — record one (iris_record_start/stop) first';
  }
}

/**
 * M8 Stage A FLOWFMT: persist a compiled recording as a git-checked, anchor-resolved flow and
 * read flows back. iris_flow_save converts a CompiledProgram's steps to semantic anchors;
 * iris_flow_list/iris_flow_load read .iris/flows/. Disk failures are returned as { error, code }.
 */
export const FLOW_TOOLS: ToolDef[] = [
  {
    name: IrisTool.FLOW_SAVE,
    description:
      'Persist the last/active recording (by name) as a git-checked, anchor-resolved flow at .iris/flows/<name>.json. Each step is bound to a SEMANTIC anchor (testid/role/signal), never a volatile ref; steps without a resolvable testid are kept with degraded:true (a "add a data-testid here" marker) rather than dropped. Returns { name, stepCount, degraded, empty } or { error, code }.',
    inputSchema: { name: z.string() },
    handler: (deps: ToolDeps, args) => {
      const name = asString(args['name']) ?? '';
      const program = deps.recordings.getCompiled(name);
      if (program === undefined) {
        return Promise.resolve({
          error: flowErrorMessage(FlowErrorCode.NO_RECORDING),
          code: FlowErrorCode.NO_RECORDING,
        });
      }
      return deps.flows
        .save(program)
        .then((res) =>
          res.ok ? res.value : { error: flowErrorMessage(res.code), code: res.code },
        );
    },
  },
  {
    name: IrisTool.FLOW_LIST,
    description:
      'List saved flow names under .iris/flows (a fresh agent learns the demonstrated journeys without a browser).',
    inputSchema: {},
    handler: (deps: ToolDeps) => deps.flows.list().then((flows) => ({ flows })),
  },
  {
    name: IrisTool.FLOW_LOAD,
    description:
      'Read + validate a saved flow by name from .iris/flows/<name>.json. Returns the FlowFile (version, name, createdAt, anchored steps) or a structured { error, code }.',
    inputSchema: { name: z.string() },
    handler: (deps: ToolDeps, args) =>
      deps.flows
        .load(asString(args['name']) ?? '')
        .then((res) =>
          res.ok ? res.value : { error: flowErrorMessage(res.code), code: res.code },
        ),
  },
  {
    name: IrisTool.FLOW_REPLAY,
    description:
      "Replay a git-checked flow from .iris/flows/<name>.json. RE-RESOLVES each step's semantic " +
      'anchor (testid via iris_query; signal via predicate) against the LIVE DOM — never reuses a ' +
      'stale ref. On an anchor MISS returns legible DRIFT { step, anchor, drift:{ reasonKind, reason, ' +
      'nearest } } (the closest surviving testid) and stops — the "whose fault is it" contract. ' +
      'Returns { name, status: ok|drift|error, steps:[...] }; a missing/malformed file is status:error ' +
      'with a structured code (distinct from a contract-changed drift).',
    inputSchema: { name: z.string(), sessionId: z.string().optional() },
    handler: async (deps: ToolDeps, args): Promise<FlowReplayResult> => {
      const name = asString(args['name']) ?? '';
      const loaded = await deps.flows.load(name);
      if (!loaded.ok) {
        return {
          name,
          status: ReplayStatus.ERROR,
          steps: [],
          error: { code: loaded.code, message: flowErrorMessage(loaded.code) },
        };
      }
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const steps = await replayFlow(
        session,
        loaded.value,
        waitForPredicate,
        FLOW_SIGNAL_TIMEOUT_MS,
      );
      const drifted = steps.some((s) => s.drift !== undefined);
      const allOk = steps.every((s) => s.ok);
      return {
        name,
        status: drifted ? ReplayStatus.DRIFT : allOk ? ReplayStatus.OK : ReplayStatus.DRIFT,
        steps,
      };
    },
  },
];
