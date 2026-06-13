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
  type FlowHealResult,
  type FlowReplayResult,
  type HealChange,
  type HealProposal,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import { replayFlow } from './flow-replay.js';
import { collectProposals } from './heal.js';
import { waitForPredicate } from './predicate.js';
import type { FlowAnnotations } from './flows.js';
import type { ToolDef, ToolDeps } from './tools.js';

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
      // M8 Stage B: fold any structured annotations (expect/dynamic/success) onto the saved flow.
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
  {
    name: IrisTool.FLOW_SAVE_RECORDED,
    description:
      'Persist the HUMAN-recorded flow from the live tab. The recorder toolbar compiles the ' +
      "human's real clicks/inputs into a semantically anchored FlowFile in-page and emits it; this " +
      'tool reads the LATEST recorded-flow from the session and writes it to .iris/flows/<name>.json ' +
      '(no recompilation — the browser already resolved every anchor). Pass `name` to override the ' +
      'recorded name. Returns { name, stepCount, degraded, empty } or { error, code } (code ' +
      'flow_no_recorded when no recording is present).',
    inputSchema: { name: z.string().optional(), ...{ sessionId: z.string().optional() } },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const recorded = latestRecordedFlow(session.eventsSince(0));
      if (recorded === undefined) {
        return {
          error: 'no human recording on this tab — start the recorder toolbar and click Stop first',
          code: RecordedSaveError.NO_RECORDED_FLOW,
        };
      }
      const override = asString(args['name']);
      const flow = override !== undefined ? { ...recorded.flow, name: override } : recorded.flow;
      const res = await deps.flows.saveFlow(flow);
      return res.ok ? res.value : { error: flowErrorMessage(res.code), code: res.code };
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
      name: z.string(),
      apply: z.boolean().optional(),
      sessionId: z.string().optional(),
    },
    handler: (deps: ToolDeps, args): Promise<FlowHealResult> => healFlow(deps, args),
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
 * M8 Stage B SELFHEAL handler: load → replay → collect confident proposals → (apply ? write : dry).
 * Never silently rewrites: only proposals that cleared HEAL_CONFIDENCE_MIN are eligible, and only
 * when apply:true. A heal disk failure maps back to status:error.
 */
async function healFlow(deps: ToolDeps, args: Record<string, unknown>): Promise<FlowHealResult> {
  const name = asString(args['name']) ?? '';
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
