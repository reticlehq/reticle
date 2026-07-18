import { z } from 'zod';
import { FlowErrorCode, RecordedSaveError, type FlowReplayResult } from '@reticlehq/core';
import type { FlowFile } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { asString } from '../tools/tools-helpers.js';
import { log } from '../log.js';
import { resolveCloudConfig, syncFlowToCloud, SyncOutcome } from '../cloud/cloud-sync.js';
import { buildSuiteVerdict } from './decision.js';
import { classifyFlowAssertions } from './flow-classify.js';
import { flowPath } from '../project/reticle-dir.js';
import type { SuiteVerdict } from '@reticlehq/core';
import type { FlowAnnotations } from './flows.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import {
  replayNamedFlow,
  flowErrorMessage,
  latestRecordedFlow,
  sessionProjectId,
} from './flow-replay-run.js';
import { healFlow } from './heal-run.js';

export { replayNamedFlow } from './flow-replay-run.js';

/**
 * Best-effort mirror of a just-saved flow to Reticle Cloud (only when logged in — both cloud env vars
 * set). Fire-and-forget: resolves the config, POSTs via the platform fetch, and logs the outcome. Any
 * failure is swallowed so a network hiccup never affects the local save.
 */
async function syncSavedFlowToCloud(flow: FlowFile, projectId: string | undefined): Promise<void> {
  const config = resolveCloudConfig(process.env);
  if (config === null) return; // not logged in → stays local
  const result = await syncFlowToCloud(flow, config, projectId, (url, init) => fetch(url, init));
  if (result.outcome !== SyncOutcome.SYNCED) {
    log('cloud-flow-sync-failed', { flow: flow.name, status: result.status, error: result.error });
  }
}

export const FLOW_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.FLOW_SAVE,
    description:
      'Persist the last/active recording (by name) as a git-checked, anchor-resolved flow at .reticle/flows/<name>.json. Each step is bound to a SEMANTIC anchor (testid/role/signal), never a volatile ref; steps without a resolvable testid are kept with degraded:true (a "add a data-testid here" marker) rather than dropped. Returns { name, stepCount, degraded, empty, assertions } — `assertions.grade` is asserted | presence-only | assertion-free: a flow that only acts (or only checks element presence) will pass even if the feature breaks, so when grade is not "asserted" follow assertions.warning and add a consequence assertion via reticle_annotate (assert-signal / assert-net / success-state).',
    inputSchema: {
      flowName: z
        .string()
        .describe(
          'Name for the flow file (saved to .reticle/flows/<flowName>.json). Use again in reticle_flow_load/reticle_flow_replay.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe('Active session ID — scopes the saved flow to that app.'),
    },
    // Schema MUST match what the handler actually returns on BOTH paths: success
    // { name, stepCount, degraded, empty, assertions? } and error { error, code }. The prior schema
    // declared { saved, path } — fields the handler never returns — so a schema-validating MCP
    // client rejected every reticle_flow_save result ("expected boolean"). Unit tests call the handler
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
      const projectId = sessionProjectId(deps, asString(args['sessionId']));
      return deps.flows.save(program, annotations, projectId).then(async (res) => {
        if (!res.ok) return { error: flowErrorMessage(res.code), code: res.code };
        deps.annotations.clear(name);
        // Grade the saved flow's assertions so the agent learns immediately if it just saved a flow
        // that asserts nothing observable (passes even when the feature is broken).
        const loaded = await deps.flows.load(res.value.name, projectId);
        return loaded.ok
          ? { ...res.value, assertions: classifyFlowAssertions(loaded.value) }
          : res.value;
      });
    },
  },
  {
    name: ReticleTool.FLOW_LIST,
    description:
      'List saved flow names under .reticle/flows (a fresh agent learns the demonstrated journeys ' +
      'without a browser). Scoped to the connected app: with a session it lists that project’s ' +
      'flows plus legacy untagged ones; with no browser it lists every flow in the repo.',
    inputSchema: {
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID — scopes the list to that app. Omit to list every saved flow.',
        ),
    },
    outputSchema: {
      flows: z.array(
        z.object({ name: z.string(), path: z.string(), createdAt: z.number().optional() }),
      ),
    },
    // Return {name, path} objects to MATCH the declared outputSchema. Returning bare name strings
    // (the prior bug) made schema-validating MCP clients reject the result ("expected object,
    // received string") — caught driving the live demo.
    handler: (deps: ToolDeps, args) => {
      const projectId = sessionProjectId(deps, asString(args['sessionId']));
      return deps.flows.list(projectId).then((names) => ({
        flows: names.map((name) => ({ name, path: flowPath(deps.reticleRoot, name, projectId) })),
      }));
    },
  },
  {
    name: ReticleTool.FLOW_LOAD,
    description:
      'Read + validate a saved flow by flowName from .reticle/flows/<flowName>.json. Returns the FlowFile (version, flowName, createdAt, anchored steps) or a structured { error, code }.',
    inputSchema: {
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from reticle_flow_list.'),
      sessionId: z
        .string()
        .optional()
        .describe('Active session ID — resolves the flow within that app’s scope.'),
    },
    outputSchema: {
      flowName: z.string(),
      steps: z.array(z.unknown()),
      createdAt: z.number().optional(),
    },
    handler: (deps: ToolDeps, args) => {
      const projectId = sessionProjectId(deps, asString(args['sessionId']));
      return deps.flows.load(asString(args['flowName']) ?? '', projectId).then((res) => {
        if (!res.ok) return { error: flowErrorMessage(res.code), code: res.code };
        const { name, ...rest } = res.value;
        return { flowName: name, ...rest };
      });
    },
  },
  {
    name: ReticleTool.FLOW_DELETE,
    description:
      'Delete a saved flow file so a renamed/obsolete flow stops lingering in the replay list. Scoped ' +
      'to the connected app. Returns { deleted: true } or a structured { error, code } (code not_found ' +
      'when no such flow — deleting an absent flow is an error, not a silent no-op).',
    inputSchema: {
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from reticle_flow_list.'),
      sessionId: z
        .string()
        .optional()
        .describe('Active session ID — resolves the flow within that app’s scope.'),
    },
    outputSchema: {
      deleted: z.boolean().optional(),
      error: z.string().optional(),
      code: z.string().optional(),
    },
    handler: (deps: ToolDeps, args) => {
      const projectId = sessionProjectId(deps, asString(args['sessionId']));
      return deps.flows.remove(asString(args['flowName']) ?? '', projectId).then((res) => {
        if (!res.ok) return { error: flowErrorMessage(res.code), code: res.code };
        return { deleted: true };
      });
    },
  },
  {
    name: ReticleTool.FLOW_REPLAY,
    description:
      "Replay a git-checked flow from .reticle/flows/<name>.json. RE-RESOLVES each step's semantic " +
      'anchor (testid via reticle_query; signal via predicate) against the LIVE DOM — never reuses a ' +
      'stale ref. On an anchor MISS returns legible DRIFT { step, anchor, drift:{ reasonKind, reason, ' +
      'nearest } } (the closest surviving testid) and stops — the "whose fault is it" contract. ' +
      'Returns { name, status: ok|drift|error, steps:[...] }; missing/malformed files and action ' +
      'failures are status:error with a structured code (distinct from contract-changed drift).',
    inputSchema: {
      flowName: z
        .string()
        .describe('Flow file name (without .json extension) from reticle_flow_list.'),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe('Set true to allow destructive controls during this replay only.'),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
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
    name: ReticleTool.FLOW_VERIFY,
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
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
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
      const sessionId = asString(args['sessionId']);
      // "Replay all" means all of THIS app's flows (+ legacy), not every project's on a shared daemon.
      const requested = Array.isArray(args['names'])
        ? args['names'].filter((n): n is string => typeof n === 'string')
        : await deps.flows.list(sessionProjectId(deps, sessionId));
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
    name: ReticleTool.FLOW_SAVE_RECORDED,
    description:
      'Persist the HUMAN-recorded flow from the live tab. The recorder toolbar compiles the ' +
      "human's real clicks/inputs into a semantically anchored FlowFile in-page and emits it; this " +
      'tool reads the LATEST recorded-flow from the session and writes it to .reticle/flows/<name>.json ' +
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
            'Active session ID from reticle_sessions. Omit when only one browser session is open.',
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
      // The store stamps the project into the file AND routes it to the per-project subdir (a shared
      // daemon serves many apps), so location and content agree from one source of truth.
      const res = await deps.flows.saveFlow(flow, session.projectId);
      if (!res.ok) return { error: flowErrorMessage(res.code), code: res.code };
      // If logged into Reticle Cloud, mirror the saved flow to the team's regression suite. Best-effort
      // and non-blocking: the flow is already on disk, so a sync failure never fails the save.
      void syncSavedFlowToCloud(flow, session.projectId);
      // Return the SaveSummary as-is ({ name, stepCount, degraded, empty }) — the outputSchema
      // declares `name`, so the old `flowName` key was silently stripped by schema-strict clients.
      return res.value;
    },
  },
  {
    name: ReticleTool.FLOW_HEAL,
    description:
      'Self-healing replay. Re-runs reticle_flow_replay; on testid DRIFT computes confidence-scored ' +
      'nearest-match rebind PROPOSALS. With apply:false (default) returns the proposed diff WITHOUT ' +
      'writing. With apply:true, writes the confident rebind(s) back into .reticle/flows/<name>.json and ' +
      'returns what changed — never silently. Before writing, apply re-replays the healed flow and ' +
      're-asserts its success consequence: if the rebound locator resolves but the consequence no ' +
      'longer fires, the write is REFUSED (status:consequence_broken) — it heals the locator, never ' +
      'the intent. A drift with no proposal above the confidence floor is status:unhealable (file ' +
      'untouched). Returns { name, status: healed|drift|unhealable|consequence_broken|' +
      'nothing_to_heal|error, applied, proposals[], changed[], message }.',
    inputSchema: {
      flowName: z.string().describe('Flow file name to heal (from reticle_flow_list).'),
      apply: z.boolean().optional(),
      confirmDangerous: z
        .boolean()
        .optional()
        .describe('Set true to allow destructive controls during this heal replay only.'),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
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
