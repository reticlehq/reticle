import { IrisTool } from './tool-names.js';
import type { ToolDef } from './tools.js';

/**
 * Which MCP tool surface to expose.
 *   core     — look→act→observe→assert loop only (~13 tools). Minimal token cost.
 *   standard — core + the most common extras: inspect, sequences, network/console readers,
 *              wait_for, flows, session lifecycle, scroll (~27 tools). The recommended default
 *              for coding agents that need more than the bare loop.
 *   full     — all tools. Default. No change for existing callers.
 */
export const TOOL_PROFILE = {
  CORE: 'core',
  STANDARD: 'standard',
  FULL: 'full',
} as const;
export type ToolProfile = (typeof TOOL_PROFILE)[keyof typeof TOOL_PROFILE];

export const TOOL_PROFILE_ENV = 'IRIS_TOOL_PROFILE';

export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  IrisTool.SESSIONS,
  IrisTool.SNAPSHOT,
  IrisTool.QUERY,
  IrisTool.ACT,
  IrisTool.ACT_AND_WAIT,
  IrisTool.OBSERVE,
  IrisTool.WAIT_FOR,
  IrisTool.ASSERT,
  IrisTool.STATE,
  IrisTool.DIFF,
  IrisTool.CAPABILITIES,
  IrisTool.NARRATE,
  IrisTool.PROJECT,
]);

export const STANDARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CORE_TOOL_NAMES,
  IrisTool.ACT_SEQUENCE,
  IrisTool.INSPECT,
  IrisTool.NETWORK,
  IrisTool.CONSOLE,
  IrisTool.ANIMATIONS,
  IrisTool.FLOW_SAVE,
  IrisTool.FLOW_LIST,
  IrisTool.FLOW_LOAD,
  IrisTool.FLOW_REPLAY,
  IrisTool.FLOW_HEAL,
  IrisTool.SESSION,
  IrisTool.END_SESSION,
  IrisTool.RESUME,
  IrisTool.MESSAGES,
  IrisTool.SCROLL_TO,
  IrisTool.CRAWL,
  IrisTool.RECORD_START,
  IrisTool.RECORD_STOP,
  IrisTool.REPLAY,
  IrisTool.EXPLORE,
  IrisTool.BASELINE_SAVE,
  IrisTool.BASELINE_LIST,
  IrisTool.CONTRACT_SAVE,
]);

export function resolveToolProfile(explicit?: string): ToolProfile {
  const raw = explicit ?? process.env[TOOL_PROFILE_ENV];
  if (raw === TOOL_PROFILE.CORE) return TOOL_PROFILE.CORE;
  if (raw === TOOL_PROFILE.STANDARD) return TOOL_PROFILE.STANDARD;
  return TOOL_PROFILE.FULL;
}

export function filterTools(tools: ToolDef[], profile: ToolProfile): ToolDef[] {
  if (profile === TOOL_PROFILE.CORE) return tools.filter((t) => CORE_TOOL_NAMES.has(t.name));
  if (profile === TOOL_PROFILE.STANDARD)
    return tools.filter((t) => STANDARD_TOOL_NAMES.has(t.name));
  return tools;
}
