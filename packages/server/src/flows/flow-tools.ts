import { z } from 'zod';
import {
  EventType,
  FLOW_SIGNAL_TIMEOUT_MS,
  FlowErrorCode,
  HEAL_CONFIDENCE_MIN,
  HealStatus,
  RecordedFlowSchema,
  RecordedSaveError,
  ReplayStatus,
  RunKind,
  RunStatus,
  type FlowHealResult,
  type FlowReplayResult,
  type HealChange,
  type HealProposal,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import { asString } from '../tools/tools-helpers.js';
import { replayFlow } from './flow-replay.js';
import { collectProposals } from './heal.js';
import { waitForPredicate } from '../events/predicate.js';
import type { FlowAnnotations } from './flows.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

/** The latest valid recorded-flow payload in a session's buffer, or undefined (never throws). */
function latestRecordedFlow(
  events: IrisEvent[],
): { name: string; flow: import('@syrin/iris-protocol').FlowFile } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== EventType.FLOW_RECORDED) continue;
    const parsed = RecordedFlowSchema.safeParse(event.data);
    if (parsed.success) return { name: parsed.data.name, flow: parsed.data.flow };
  }
  return undefined;
}

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

/** Map the wire ReplayStatus onto the persisted RunStatus (ok→pass). */
function replayToRunStatus(status: ReplayStatus): RunStatus {
  switch (status) {
    case ReplayStatus.OK:
      return RunStatus.PASS;
    case ReplayStatus.DRIFT:
      return RunStatus.DRIFT;
    case ReplayStatus.ERROR:
      return RunStatus.ERROR;
  }
}

/** Append a flow-replay outcome to .iris/project.json (never throws into replay). */
async function recordReplayRun(
  deps: ToolDeps,
  name: string,
  status: ReplayStatus,
  driftSteps: number,
  durationMs: number,
): Promise<void> {
  await deps.project.recordRun({
    kind: RunKind.FLOW_REPLAY,
    name,
    status: replayToRunStatus(status),
    evidence: { driftSteps },
    durationMs,
  });
}

/**
 * Persist a compiled recording as a git-checked, anchor-resolved flow and
 * read flows back. iris_flow_save converts a CompiledProgram's steps to semantic anchors;
 * iris_flow_list/iris_flow_load read .iris/flows/. Disk failures are returned as { error, code }.
 */
export const FLOW_TOOLS: ToolDef[] = [
  {
    name: IrisTool.FLOW_SAVE,
    description:
      'Persist the last/active recording (by name) as a git-checked, anchor-resolved flow at .iris/flows/<name>.json. Each step is bound to a SEMANTIC anchor (testid/role/signal), never a volatile ref; steps without a resolvable testid are kept with degraded:true (a "add a data-testid here" marker) rather than dropped. Returns { name, stepCount, degraded, empty } or { error, code }.',
    inputSchema: {
      flowName: z
        .string()
        .describe(
          'Name for the flow file (saved to .iris/flows/<flowName>.json). Use again in iris_flow_load/iris_flow_replay.',
        ),
    },
    outputSchema: {
      saved: z.boolean(),
      path: z.string(),
      stepCount: z.number().optional(),
      degraded: z.number().optional(),
    },
    handler: (deps: ToolDeps, args) => {
      const name = asString(args['flowName']) ?? '';
      const program = deps.recordings.getCompiled(name);
      if (program === undefined) {
        return Promise.resolve({
          error: flowErrorMessage(FlowErrorCode.NO_RECORDING),
          code: FlowErrorCode.NO_RECORDING,
        });
      }
      // fold any structured annotations (expect/dynamic/success) onto the saved flow.
      const success = deps.annotations.success(name);
      const annotations: FlowAnnotations = {
        stepExpect: deps.annotations.stepExpect(name),
        dynamic: deps.annotations.dynamic(name),
        ...(success !== undefined ? { success } : {}),
      };
      return deps.flows.save(program, annotations).then((res) => {
        if (res.ok) deps.annotations.clear(name);
        return res.ok ? res.value : { error: flowErrorMessage(res.code), code: res.code };
      });
    },
  },
  {
    name: IrisTool.FLOW_LIST,
    description:
      'List saved flow names under .iris/flows (a fresh agent learns the demonstrated journeys without a browser).',
    inputSchema: {},
    outputSchema: {
      flows: z.array(
        z.object({ name: z.string(), path: z.string(), createdAt: z.number().optional() }),
      ),
    },
    handler: (deps: ToolDeps) => deps.flows.list().then((flows) => ({ flows })),
  },
  {
    name: IrisTool.FLOW_LOAD,
    description:
      'Read + validate a saved flow by flowName from .iris/flows/<flowName>.json. Returns the FlowFile (version, flowName, createdAt, anchored steps) or a structured { error, code }.',
    inputSchema: {
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from iris_flow_list.'),
    },
    outputSchema: {
      flowName: z.string(),
      steps: z.array(z.unknown()),
      createdAt: z.number().optional(),
    },
    handler: (deps: ToolDeps, args) =>
      deps.flows.load(asString(args['flowName']) ?? '').then((res) => {
        if (!res.ok) return { error: flowErrorMessage(res.code), code: res.code };
        const { name, ...rest } = res.value;
        return { flowName: name, ...rest };
      }),
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
    inputSchema: {
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from iris_flow_list.'),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from iris_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      status: z.string().describe('ok | drift | error'),
      steps: z.array(z.unknown()),
      proposals: z.array(z.unknown()).optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    },
    handler: async (deps: ToolDeps, args): Promise<FlowReplayResult> => {
      // deps.now() here is the single clock site for the replay duration (a
      // handler-level concern, not pure logic), and every exit path records a run to project.json.
      const startedAt = deps.now();
      const name = asString(args['flowName']) ?? '';
      const loaded = await deps.flows.load(name);
      if (!loaded.ok) {
        await recordReplayRun(deps, name, ReplayStatus.ERROR, 0, deps.now() - startedAt);
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
      const driftSteps = steps.filter((s) => s.drift !== undefined).length;
      const allOk = steps.every((s) => s.ok);
      const status =
        driftSteps > 0 ? ReplayStatus.DRIFT : allOk ? ReplayStatus.OK : ReplayStatus.DRIFT;
      await recordReplayRun(deps, name, status, driftSteps, deps.now() - startedAt);
      return { name, status, steps };
    },
  },
  {
    name: IrisTool.FLOW_SAVE_RECORDED,
    description:
      'Persist the HUMAN-recorded flow from the live tab. The recorder toolbar compiles the ' +
      "human's real clicks/inputs into a semantically anchored FlowFile in-page and emits it; this " +
      'tool reads the LATEST recorded-flow from the session and writes it to .iris/flows/<name>.json ' +
      '(no recompilation — the browser already resolved every anchor). Pass `name` to override the ' +
      'recorded name. Returns { name, stepCount, degraded, empty } or { error, code } (code ' +
      'flow_no_recorded when no recording is present).',
    inputSchema: {
      flowName: z
        .string()
        .optional()
        .describe(
          'Override the flow name embedded in the recorded flow. Omit to use the recorder-assigned name.',
        ),
      ...{
        sessionId: z
          .string()
          .optional()
          .describe(
            'Active session ID from iris_sessions. Omit when only one browser session is open.',
          ),
      },
    },
    outputSchema: {
      flowName: z.string().optional(),
      stepCount: z.number().optional(),
      degraded: z.number().optional(),
      error: z.string().optional(),
      code: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const recorded = latestRecordedFlow(session.eventsSince(0));
      if (recorded === undefined) {
        return {
          error: 'no human recording on this tab — start the recorder toolbar and click Stop first',
          code: RecordedSaveError.NO_RECORDED_FLOW,
        };
      }
      const override = asString(args['flowName']);
      const flow = override !== undefined ? { ...recorded.flow, name: override } : recorded.flow;
      const res = await deps.flows.saveFlow(flow);
      if (!res.ok) return { error: flowErrorMessage(res.code), code: res.code };
      const { name, ...rest } = res.value;
      return { flowName: name, ...rest };
    },
  },
  {
    name: IrisTool.FLOW_HEAL,
    description:
      'Self-healing replay. Re-runs iris_flow_replay; on testid DRIFT computes confidence-scored ' +
      'nearest-match rebind PROPOSALS. With apply:false (default) returns the proposed diff WITHOUT ' +
      'writing. With apply:true, writes the confident rebind(s) back into .iris/flows/<name>.json and ' +
      'returns what changed — never silently. A drift with no proposal above the confidence floor is ' +
      'status:unhealable (file untouched). Returns { name, status: healed|drift|unhealable|' +
      'nothing_to_heal|error, applied, proposals[], changed[], message }.',
    inputSchema: {
      flowName: z.string().describe('Flow file name to heal (from iris_flow_list).'),
      apply: z.boolean().optional(),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from iris_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      flowName: z.string(),
      status: z.string(),
      applied: z.boolean(),
      proposals: z.array(z.unknown()),
      changed: z.array(z.unknown()),
      message: z.string(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    },
    handler: (deps: ToolDeps, args) =>
      healFlow(deps, args).then(({ name, ...rest }) => ({ flowName: name, ...rest })),
  },
];

const HEAL_MESSAGES = {
  NOTHING: 'nothing to heal — every anchor resolved on replay',
  HEALED: 'rewrote drifted testid anchors to their nearest surviving match',
  DRIFT_DRY: 'confident rebind(s) proposed — re-run with apply:true to write them to disk',
  UNHEALABLE: `drift found, but no nearest match cleared the confidence floor (HEAL_CONFIDENCE_MIN=${HEAL_CONFIDENCE_MIN}); file left untouched — add a data-testid or fix the flow by hand`,
} as const;

function toChange(proposal: HealProposal): HealChange {
  return { step: proposal.step, from: proposal.from, to: proposal.to };
}

/**
 * Self-heal handler: load → replay → collect confident proposals → (apply ? write : dry).
 * Never silently rewrites: only proposals that cleared HEAL_CONFIDENCE_MIN are eligible, and only
 * when apply:true. A heal disk failure maps back to status:error.
 */
async function healFlow(deps: ToolDeps, args: Record<string, unknown>): Promise<FlowHealResult> {
  const name = asString(args['flowName']) ?? '';
  const apply = args['apply'] === true;
  const loaded = await deps.flows.load(name);
  if (!loaded.ok) {
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals: [],
      changed: [],
      message: flowErrorMessage(loaded.code),
      error: { code: loaded.code, message: flowErrorMessage(loaded.code) },
    };
  }

  const session = deps.sessions.resolve(asString(args['sessionId']));
  const steps = await replayFlow(session, loaded.value, waitForPredicate, FLOW_SIGNAL_TIMEOUT_MS);
  const drifted = steps.some((s) => s.drift !== undefined);
  if (!drifted) {
    return {
      name,
      status: HealStatus.NOTHING_TO_HEAL,
      applied: false,
      proposals: [],
      changed: [],
      message: HEAL_MESSAGES.NOTHING,
    };
  }

  const proposals = collectProposals(steps);
  if (proposals.length === 0) {
    return {
      name,
      status: HealStatus.UNHEALABLE,
      applied: false,
      proposals: [],
      changed: [],
      message: HEAL_MESSAGES.UNHEALABLE,
    };
  }

  if (!apply) {
    return {
      name,
      status: HealStatus.DRIFT,
      applied: false,
      proposals,
      changed: [],
      message: HEAL_MESSAGES.DRIFT_DRY,
    };
  }

  const written = await deps.flows.heal(name, proposals.map(toChange));
  if (!written.ok) {
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals,
      changed: [],
      message: flowErrorMessage(written.code),
      error: { code: written.code, message: flowErrorMessage(written.code) },
    };
  }
  return {
    name,
    status: HealStatus.HEALED,
    applied: written.value.changed.length > 0,
    proposals,
    changed: written.value.changed,
    message: HEAL_MESSAGES.HEALED,
  };
}
