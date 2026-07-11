import { healthEnvelope } from '../session/session-health.js';
import { asString } from './tools-helpers.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDef, ToolDeps } from './tools.js';

/**
 * The live-session tools whose result MUST carry the
 * session-health envelope. Owned in ONE place — not retrofitted per handler — so a throttled tab
 * can never return a healthy-looking result from any of these. `runTool` is the single choke point
 * (mcp.ts + tool-invoker.ts) that splices health on; the guard test asserts the set is exhaustive.
 */
export const SESSION_BOUND_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.INSPECT,
  ReticleTool.ACT,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.OBSERVE,
  ReticleTool.WAIT_FOR,
  ReticleTool.ASSERT,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.ANIMATIONS,
  ReticleTool.BASELINE_SAVE,
  ReticleTool.DIFF,
  ReticleTool.RECORD_START,
  ReticleTool.RECORD_STOP,
  ReticleTool.REPLAY,
  ReticleTool.NARRATE,
  ReticleTool.CLOCK,
  ReticleTool.STATE,
  ReticleTool.EXPLORE,
  ReticleTool.CRAWL,
  ReticleTool.SCROLL_TO,
  ReticleTool.NAVIGATE,
  ReticleTool.REFRESH,
]);

/**
 * Tools that carry a `sessionId` arg but are NOT live-session-health tools — they read/write
 * disk (capabilities/contract/flow/project), drain a buffer, or steer session lifecycle. They are
 * exempt from the health splice ON PURPOSE. Kept explicit so the guard test can force every new
 * `sessionId`-bearing tool to be classified into exactly one set (bound XOR exempt).
 */
export const SESSION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.CAPABILITIES, // has a fromDisk mode with no live session
  ReticleTool.CONTRACT_SAVE, // persists the registry to disk
  ReticleTool.FLOW_SAVE, // sessionId only scopes the write to the app's flow subdir; disk-side
  ReticleTool.FLOW_LIST, // sessionId only scopes which project's flows are listed; disk read
  ReticleTool.FLOW_LOAD, // sessionId only scopes which project's flow is read; disk read
  ReticleTool.FLOW_REPLAY, // returns its own FlowReplayResult contract (+ auto-records a run)
  ReticleTool.FLOW_VERIFY, // returns its own SuiteVerdict contract (replays the whole suite)
  ReticleTool.FLOW_SAVE_RECORDED, // reads the recording buffer, writes disk
  ReticleTool.FLOW_HEAL, // returns its own FlowHealResult contract
  ReticleTool.PROJECT, // reads .reticle/project.json
  ReticleTool.RUN_RECORD, // writes .reticle/project.json
  ReticleTool.RUN_EXPORT, // reads .reticle/runs/<id>.json (verification-run artifact)
  ReticleTool.END_SESSION, // live-control lifecycle
  ReticleTool.YIELD, // live-control lifecycle (hand back to the human between turns)
  ReticleTool.RESUME, // live-control lifecycle
  ReticleTool.MESSAGES, // drains the human→agent inbox
  ReticleTool.REVIEW, // lists/resolves human review marks; own contract, no live-DOM read
  ReticleTool.SESSION, // tunes the presenter session (idle-end); own contract
  ReticleTool.SCREENSHOT, // own contract; provider-driven, not a live-DOM-health read
  ReticleTool.VISUAL_DIFF, // own contract (matched/ratio/region)
  ReticleTool.NETWORK_MOCK, // own contract (applied/count); provider-driven, not a live-DOM read
  ReticleTool.VIEWPORT, // own contract (applied/width/height); provider-driven, not a live-DOM read
  ReticleTool.ANNOTATE, // annotates a recording's steps; pure disk-side metadata, no live DOM read
  ReticleTool.LEASE_RELEASE, // its sessionId is a pool lease id, not a live session; no health splice
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The single entry point both the MCP server and the programmatic invoker call instead of
 * `tool.handler` directly. Runs the handler, then — for a live-session tool returning a plain
 * object that did not already include `session` — splices the health envelope on. Idempotent
 * (handlers that already add health are left untouched) and never alters non-object results.
 */
export async function runTool(
  tool: ToolDef,
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Heartbeat: any tool call targeting a leased session keeps its pool lease alive, so the
  // LeaseReaper only reclaims genuinely orphaned (crashed/hung-agent) leases.
  const targetSession = asString(args['sessionId']);
  if (targetSession !== undefined) deps.pool?.touch(targetSession);
  const result = await tool.handler(deps, args);
  if (!SESSION_BOUND_TOOLS.has(tool.name)) return result;
  if (!isPlainObject(result) || 'session' in result) return result;
  const session = deps.sessions.resolve(asString(args['sessionId']));
  const envelope: Record<string, unknown> = { ...healthEnvelope(session) };
  const lease = session.takeSessionLease();
  if (lease !== undefined) envelope['session_lease'] = lease;
  const warning = session.ageWarning();
  if (warning !== undefined) envelope['session_age_warning'] = warning;
  return { ...result, ...envelope };
}
