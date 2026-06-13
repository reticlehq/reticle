import { healthEnvelope } from './session-health.js';
import { asString } from './tools-helpers.js';
import { IrisTool } from './tool-names.js';
import type { ToolDef, ToolDeps } from './tools.js';

/**
 * N2 STATUS-HONESTY (universal invariant): the live-session tools whose result MUST carry the
 * session-health envelope. Owned in ONE place — not retrofitted per handler — so a throttled tab
 * can never return a healthy-looking result from any of these. `runTool` is the single choke point
 * (mcp.ts + tool-invoker.ts) that splices health on; the guard test asserts the set is exhaustive.
 */
export const SESSION_BOUND_TOOLS: ReadonlySet<string> = new Set([
  IrisTool.SNAPSHOT,
  IrisTool.QUERY,
  IrisTool.INSPECT,
  IrisTool.ACT,
  IrisTool.ACT_SEQUENCE,
  IrisTool.ACT_AND_WAIT,
  IrisTool.OBSERVE,
  IrisTool.WAIT_FOR,
  IrisTool.ASSERT,
  IrisTool.NETWORK,
  IrisTool.CONSOLE,
  IrisTool.ANIMATIONS,
  IrisTool.BASELINE_SAVE,
  IrisTool.DIFF,
  IrisTool.RECORD_START,
  IrisTool.RECORD_STOP,
  IrisTool.REPLAY,
  IrisTool.NARRATE,
  IrisTool.CLOCK,
  IrisTool.STATE,
  IrisTool.EXPLORE,
]);

/**
 * N2: tools that carry a `sessionId` arg but are NOT live-session-health tools — they read/write
 * disk (capabilities/contract/flow/project), drain a buffer, or steer session lifecycle. They are
 * exempt from the health splice ON PURPOSE. Kept explicit so the guard test can force every new
 * `sessionId`-bearing tool to be classified into exactly one set (bound XOR exempt).
 */
export const SESSION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  IrisTool.CAPABILITIES, // has a fromDisk mode with no live session
  IrisTool.CONTRACT_SAVE, // persists the registry to disk
  IrisTool.FLOW_REPLAY, // returns its own FlowReplayResult contract (+ auto-records a run)
  IrisTool.FLOW_SAVE_RECORDED, // reads the recording buffer, writes disk
  IrisTool.FLOW_HEAL, // returns its own FlowHealResult contract
  IrisTool.PROJECT, // reads .iris/project.json
  IrisTool.RUN_RECORD, // writes .iris/project.json
  IrisTool.END_SESSION, // live-control lifecycle
  IrisTool.RESUME, // live-control lifecycle
  IrisTool.MESSAGES, // drains the human→agent inbox
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
  const result = await tool.handler(deps, args);
  if (!SESSION_BOUND_TOOLS.has(tool.name)) return result;
  if (!isPlainObject(result) || 'session' in result) return result;
  const session = deps.sessions.resolve(asString(args['sessionId']));
  return { ...result, ...healthEnvelope(session) };
}
