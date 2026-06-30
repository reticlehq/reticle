import { ReticleTool } from './tool-names.js';
import type { ToolDef } from './tools.js';

/**
 * Which MCP tool surface to expose. The advertised tool DEFINITIONS are re-sent to the model on
 * every turn, so a smaller surface is a per-turn token saving that compounds across a loop —
 * measured ~14.6k tok/turn at full (48 tools) vs ~half that for core. Fewer tools also makes the
 * model wander less (fewer turns, higher accuracy). See bench/LAYER-B.md.
 *
 *   core     — the verify loop a coding agent actually needs: navigate→look→act→observe→assert,
 *              WITH direct network + console + state observability (the highest-signal checks).
 *              ~12 tools. The recommended profile for agent-driven verification.
 *   standard — core + common extras (inspect, sequences, animations, flows, session lifecycle,
 *              scroll, baselines, …). For agents that need more than the bare loop.
 *   hybrid   — THE DEFAULT: core verify+oracle tools advertised directly + 2 meta-tools for on-demand
 *              reach to everything else. Core accuracy/detection at ~64% less schema tax than full.
 *   full     — all tools advertised directly. Opt in via RETICLE_TOOL_PROFILE=full for hard-call scripts.
 */
export const TOOL_PROFILE = {
  /** dynamic — advertise only 2 meta-tools (reticle_tools + reticle_run); load real tools on demand.
   *  Fixed ~hundreds of tokens/turn regardless of how many tools exist. See dynamic-tools.ts. */
  DYNAMIC: 'dynamic',
  /** hybrid — the core verify tools advertised directly (so the agent acts reliably) PLUS the 2
   *  meta-tools for on-demand reach to every other tool. Core accuracy + full reach at ~core cost. */
  HYBRID: 'hybrid',
  CORE: 'core',
  STANDARD: 'standard',
  FULL: 'full',
} as const;
export type ToolProfile = (typeof TOOL_PROFILE)[keyof typeof TOOL_PROFILE];

export const TOOL_PROFILE_ENV = 'RETICLE_TOOL_PROFILE';

// The set an agent needs to verify a change end-to-end. Tool DEFINITIONS are re-sent every turn,
// so a smaller surface compounds — but there is a floor: an 8-tool cut (dropping act/navigate/
// wait_for/sessions) was MEASURED to regress real-agent accuracy from 5/5 to 3/5, because the
// model loses scaffolding and wanders (more turns) on harder flows. These 12 are the lean sweet
// spot that holds 5/5 in a real gpt-4o loop. Direct network/console stay (far more discoverable
// than observe-with-filters → fewer turns, better verdicts). See bench/LAYER-B.md.
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ReticleTool.SESSIONS,
  ReticleTool.NAVIGATE,
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.OBSERVE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.WAIT_FOR,
  ReticleTool.ASSERT,
  ReticleTool.STATE,
]);

const STANDARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CORE_TOOL_NAMES,
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.INSPECT,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.ANIMATIONS,
  ReticleTool.FLOW_SAVE,
  ReticleTool.FLOW_LIST,
  ReticleTool.FLOW_LOAD,
  ReticleTool.FLOW_REPLAY,
  ReticleTool.FLOW_VERIFY,
  ReticleTool.FLOW_HEAL,
  ReticleTool.SESSION,
  ReticleTool.END_SESSION,
  ReticleTool.YIELD,
  ReticleTool.RESUME,
  ReticleTool.MESSAGES,
  ReticleTool.REVIEW,
  ReticleTool.WAIT_READY,
  ReticleTool.SCROLL_TO,
  ReticleTool.CRAWL,
  ReticleTool.RECORD_START,
  ReticleTool.RECORD_STOP,
  ReticleTool.REPLAY,
  ReticleTool.EXPLORE,
  ReticleTool.BASELINE_SAVE,
  ReticleTool.BASELINE_LIST,
  ReticleTool.CONTRACT_SAVE,
  ReticleTool.NETWORK_MOCK,
  ReticleTool.VIEWPORT,
]);

export function resolveToolProfile(explicit?: string): ToolProfile {
  const raw = explicit ?? process.env[TOOL_PROFILE_ENV];
  if (raw === TOOL_PROFILE.DYNAMIC) return TOOL_PROFILE.DYNAMIC;
  if (raw === TOOL_PROFILE.HYBRID) return TOOL_PROFILE.HYBRID;
  if (raw === TOOL_PROFILE.CORE) return TOOL_PROFILE.CORE;
  if (raw === TOOL_PROFILE.STANDARD) return TOOL_PROFILE.STANDARD;
  if (raw === TOOL_PROFILE.FULL) return TOOL_PROFILE.FULL;
  // Default: hybrid — the core verify+oracle tools advertised directly (no detection loss, verified
  // 10/10 on the regression bench) PLUS the 2 meta-tools for on-demand reach to every other tool. ~64%
  // less per-turn schema than `full` at the same accuracy. Explicit `full` still opts into all tools.
  return TOOL_PROFILE.HYBRID;
}

export function filterTools(tools: ToolDef[], profile: ToolProfile): ToolDef[] {
  if (profile === TOOL_PROFILE.CORE) return tools.filter((t) => CORE_TOOL_NAMES.has(t.name));
  if (profile === TOOL_PROFILE.STANDARD)
    return tools.filter((t) => STANDARD_TOOL_NAMES.has(t.name));
  return tools;
}
