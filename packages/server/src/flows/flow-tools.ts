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
import { buildDecision, buildSuiteVerdict } from './decision.js';
import { classifyFlowAssertions } from './flow-classify.js';
import { assertSuccess, dynamicTestids, successLabel } from './flow-success.js';
import { flowPath } from '../project/iris-dir.js';
import { applyHealChanges, collectProposals } from './heal.js';
import type { FlowStepResult, SuiteVerdict } from '@syrin/iris-protocol';
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
 * Replay one named flow end to end: load → re-resolve+run each step → assert the success oracle →
 * status + decision. Shared by iris_flow_replay (single flow) and iris_flow_verify (whole suite) so
 * both produce identical FlowReplayResults. Every exit path records a run to project.json.
 */
export async function replayNamedFlow(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<FlowReplayResult> {
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
  // Floor the success oracle at the start of THIS replay so a stale signal from a prior run
  // in the same session can't fake a pass.
  const replayFloor = session.elapsed();
  const steps = await replayFlow(
    session,
    loaded.value,
    waitForPredicate,
    FLOW_SIGNAL_TIMEOUT_MS,
    args['confirmDangerous'] === true,
  );
  // "green means intent satisfied": when every step ran clean, assert the flow's success
  // end-condition as a real consequence. A signal/net success that never fires FAILS the replay
  // even though all locators resolved — the regression a healed-but-wrong locator ships green.
  const stepsClean = steps.length > 0 && steps.every((s) => s.ok && s.drift === undefined);
  if (stepsClean && loaded.value.success !== undefined) {
    const verdict = await assertSuccess(
      session,
      loaded.value.success,
      dynamicTestids(loaded.value),
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
      replayFloor,
    );
    const row: FlowStepResult = {
      step: steps.length,
      tool: 'success',
      anchor: successLabel(loaded.value.success),
      ok: verdict.pass,
      ...(verdict.pass ? {} : { error: verdict.failureReason ?? 'flow.success not satisfied' }),
    };
    steps.push(row);
  }
  const driftSteps = steps.filter((s) => s.drift !== undefined).length;
  const allOk = steps.every((s) => s.ok);
  const status = driftSteps > 0 ? ReplayStatus.DRIFT : allOk ? ReplayStatus.OK : ReplayStatus.ERROR;
  await recordReplayRun(deps, name, status, driftSteps, deps.now() - startedAt);
  const failed = steps.find((step) => !step.ok && step.drift === undefined);
  if (failed !== undefined) {
    const errored: FlowReplayResult = {
      name,
      status,
      steps,
      error: { code: ReplayStatus.ERROR, message: failed.error ?? 'flow action failed' },
    };
    errored.decision = buildDecision(errored, loaded.value);
    return errored;
  }
  const result: FlowReplayResult = { name, status, steps };
  if (status !== ReplayStatus.OK) result.decision = buildDecision(result, loaded.value);
  return result;
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
      'Persist the last/active recording (by name) as a git-checked, anchor-resolved flow at .iris/flows/<name>.json. Each step is bound to a SEMANTIC anchor (testid/role/signal), never a volatile ref; steps without a resolvable testid are kept with degraded:true (a "add a data-testid here" marker) rather than dropped. Returns { name, stepCount, degraded, empty, assertions } — `assertions.grade` is asserted | presence-only | assertion-free: a flow that only acts (or only checks element presence) will pass even if the feature breaks, so when grade is not "asserted" follow assertions.warning and add a consequence assertion via iris_annotate (assert-signal / assert-net / success-state).',
    inputSchema: {
      flowName: z
        .string()
        .describe(
          'Name for the flow file (saved to .iris/flows/<flowName>.json). Use again in iris_flow_load/iris_flow_replay.',
        ),
    },
    // Schema MUST match what the handler actually returns on BOTH paths: success
    // { name, stepCount, degraded, empty, assertions? } and error { error, code }. The prior schema
    // declared { saved, path } — fields the handler never returns — so a schema-validating MCP
    // client rejected every iris_flow_save result ("expected boolean"). Unit tests call the handler
    // directly and bypass MCP output validation, so only a live MCP run caught it (cf. the same
    // class of bug fixed for FLOW_LIST above).
    outputSchema: {
      name: z.string().optional(),
      stepCount: z.number().optional(),
      degraded: z.number().optional(),
      empty: z.boolean().optional(),
      assertions: z
        .object({
          grade: z.string().describe('asserted | presence-only | assertion-free'),
          hasConsequenceAssertion: z.boolean(),
          totalSteps: z.number(),
          consequenceSteps: z.number(),
          weakSteps: z.number(),
          warning: z.string().optional(),
        })
        .optional(),
      error: z.string().optional(),
      code: z.string().optional(),
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
      // fold any structured annotations (expect/dynamic/success/intent) onto the saved flow.
      const success = deps.annotations.success(name);
      const intent = deps.annotations.intent(name);
      const annotations: FlowAnnotations = {
        stepExpect: deps.annotations.stepExpect(name),
        dynamic: deps.annotations.dynamic(name),
        ...(success !== undefined ? { success } : {}),
        ...(intent !== undefined ? { intent } : {}),
      };
      return deps.flows.save(program, annotations).then(async (res) => {
        if (!res.ok) return { error: flowErrorMessage(res.code), code: res.code };
        deps.annotations.clear(name);
        // Grade the saved flow's assertions so the agent learns immediately if it just saved a flow
        // that asserts nothing observable (passes even when the feature is broken).
        const loaded = await deps.flows.load(res.value.name);
        return loaded.ok
          ? { ...res.value, assertions: classifyFlowAssertions(loaded.value) }
          : res.value;
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
    // Return {name, path} objects to MATCH the declared outputSchema. Returning bare name strings
    // (the prior bug) made schema-validating MCP clients reject the result ("expected object,
    // received string") — caught driving the live demo.
    handler: (deps: ToolDeps) =>
      deps.flows.list().then((names) => ({
        flows: names.map((name) => ({ name, path: flowPath(deps.irisRoot, name) })),
      })),
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
      'Returns { name, status: ok|drift|error, steps:[...] }; missing/malformed files and action ' +
      'failures are status:error with a structured code (distinct from contract-changed drift).',
    inputSchema: {
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from iris_flow_list.'),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe('Set true to allow destructive controls during this replay only.'),
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
      decision: z
        .object({
          verdict: z.string(),
          summary: z.string(),
          whatChanged: z.string().optional(),
          whereInSource: z.string().optional(),
          suggestedFix: z.string().optional(),
          nextAction: z.string(),
        })
        .optional()
        .describe('Autonomy envelope: verdict + what changed + where + fix + next action.'),
    },
    // The decision envelope is attached by replayNamedFlow only on drift/fail (clean pass stays
    // token-flat). Single-flow replay and whole-suite verify share that one implementation.
    handler: (deps: ToolDeps, args): Promise<FlowReplayResult> => replayNamedFlow(deps, args),
  },
  {
    name: IrisTool.FLOW_VERIFY,
    description:
      'Replay EVERY saved flow (or a given subset) and return ONE consolidated suite verdict — the ' +
      'autonomous regression check to run after a build/change. Deterministic (no LLM per flow). ' +
      'Returns { status: pass|fail, total, passed, failed, summary, failures:[{ flow, verdict, ' +
      'whatChanged, whereInSource, nextAction }] } — passing flows are counted, only failures carry ' +
      'detail (the actionable fix). One call replaces N hand-driven replays.',
    inputSchema: {
      names: z
        .array(z.string())
        .optional()
        .describe('Flow names to verify. Omit to verify every saved flow.'),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from iris_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      status: z.string().describe('pass | fail'),
      total: z.number(),
      passed: z.number(),
      failed: z.number(),
      summary: z.string(),
      failures: z.array(z.unknown()),
    },
    handler: async (deps: ToolDeps, args): Promise<SuiteVerdict> => {
      const requested = Array.isArray(args['names'])
        ? args['names'].filter((n): n is string => typeof n === 'string')
        : await deps.flows.list();
      const sessionId = asString(args['sessionId']);
      const runs: { replay: FlowReplayResult }[] = [];
      // Sequential: each flow replays against the same live session; parallel would race the DOM.
      for (const flowName of requested) {
        const replay = await replayNamedFlow(deps, { flowName, sessionId });
        runs.push({ replay });
      }
      return buildSuiteVerdict(runs);
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
    // Match the handler's actual return (SaveSummary { name, stepCount, degraded, empty } or
    // { error, code }) — the prior `flowName` key silently stripped the real `name`/`empty` fields.
    outputSchema: {
      name: z.string().optional(),
      stepCount: z.number().optional(),
      degraded: z.number().optional(),
      empty: z.boolean().optional(),
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
      'returns what changed — never silently. Before writing, apply re-replays the healed flow and ' +
      're-asserts its success consequence: if the rebound locator resolves but the consequence no ' +
      'longer fires, the write is REFUSED (status:consequence_broken) — it heals the locator, never ' +
      'the intent. A drift with no proposal above the confidence floor is status:unhealable (file ' +
      'untouched). Returns { name, status: healed|drift|unhealable|consequence_broken|' +
      'nothing_to_heal|error, applied, proposals[], changed[], message }.',
    inputSchema: {
      flowName: z.string().describe('Flow file name to heal (from iris_flow_list).'),
      apply: z.boolean().optional(),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe('Set true to allow destructive controls during this heal replay only.'),
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
  HEALED:
    "rewrote drifted testid anchors to their nearest surviving match and re-verified the flow's success consequence still fires",
  DRIFT_DRY: 'confident rebind(s) proposed — re-run with apply:true to write them to disk',
  UNHEALABLE: `drift found, but no nearest match cleared the confidence floor (HEAL_CONFIDENCE_MIN=${HEAL_CONFIDENCE_MIN}); file left untouched — add a data-testid or fix the flow by hand`,
  HEALED_UNVERIFIED:
    'rewrote drifted testid anchors — but this flow declares no success consequence, so the rebind resolves a locator without proving the intent still holds. Add a success-state assertion (iris_annotate) so future heals can be verified.',
  CONSEQUENCE_BROKEN:
    'rebind resolves the drifted locator to a surviving element, but the healed flow no longer satisfies its success consequence — refusing to write (a heal that loses the intent would ship a green-but-dead test). Fix by hand and verify',
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
  const steps = await replayFlow(
    session,
    loaded.value,
    waitForPredicate,
    FLOW_SIGNAL_TIMEOUT_MS,
    args['confirmDangerous'] === true,
  );
  const drifted = steps.some((s) => s.drift !== undefined);
  const failed = steps.find((s) => !s.ok && s.drift === undefined);
  if (failed !== undefined) {
    const message = failed.error ?? 'flow replay failed before an anchor could be healed';
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals: [],
      changed: [],
      message,
      error: { code: ReplayStatus.ERROR, message },
    };
  }
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

  // M5 invariant — "heal the locator, never the intent." Before persisting, verify the rebind on a
  // healed in-memory copy: a rebound testid can resolve to a real but WRONG element that no longer
  // triggers the flow's success consequence (e.g. a look-alike control). Persisting that would ship
  // a green flow that tests nothing. Re-replay the healed flow and assert its success; refuse the
  // write if the consequence no longer fires. Flows with no declared success can't be verified — we
  // still heal them but say so loudly so the gap is visible.
  const { flow: healed } = applyHealChanges(loaded.value, proposals.map(toChange));
  if (healed.success !== undefined) {
    // Floor the success oracle at the start of the VERIFY replay so the success signal emitted by the
    // earlier drift replay's prefix (this same heal call) cannot fake the verification.
    const verifyFloor = session.elapsed();
    const verifySteps = await replayFlow(
      session,
      healed,
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
      args['confirmDangerous'] === true,
    );
    const verifyClean =
      verifySteps.length > 0 && verifySteps.every((s) => s.ok && s.drift === undefined);
    const verdict = verifyClean
      ? await assertSuccess(
          session,
          healed.success,
          dynamicTestids(healed),
          waitForPredicate,
          FLOW_SIGNAL_TIMEOUT_MS,
          verifyFloor,
        )
      : { pass: false, failureReason: 'healed flow did not replay cleanly' };
    if (!verdict.pass) {
      return {
        name,
        status: HealStatus.CONSEQUENCE_BROKEN,
        applied: false,
        proposals,
        changed: [],
        message: `${HEAL_MESSAGES.CONSEQUENCE_BROKEN} (${successLabel(healed.success)}: ${verdict.failureReason ?? 'not satisfied'})`,
      };
    }
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
    message:
      loaded.value.success !== undefined ? HEAL_MESSAGES.HEALED : HEAL_MESSAGES.HEALED_UNVERIFIED,
  };
}
