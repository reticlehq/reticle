import { IrisTool } from './tool-names.js';
import type { ToolDef } from './tools.js';

/**
 * 0.3.7 FLUENCY: which MCP tool surface to expose. A non-deferring MCP client loads every tool's
 * schema eagerly (~10–13k standing tokens). The `core` profile trims to the look→act→observe→assert
 * loop + cross-check + run-history so a small-context agent stays fluent without the overhead. Opt in
 * with env IRIS_TOOL_PROFILE=core (or StartOptions.toolProfile); FULL is the default — no change.
 */
export const TOOL_PROFILE = {
  CORE: 'core',
  FULL: 'full',
} as const;
export type ToolProfile = (typeof TOOL_PROFILE)[keyof typeof TOOL_PROFILE];

/** Env var a non-deferring client sets to request the lean surface. */
export const TOOL_PROFILE_ENV = 'IRIS_TOOL_PROFILE';

/**
 * The core loop + the 4-layer cross-check (UI/signal/network/state) + diff regression + run-history.
 * Built from IrisTool constants so a renamed tool fails to compile rather than silently drifting.
 * Everything else (record/replay, flows, annotate, live-control, clock, explore, inspect, the raw
 * network/console/animation readers) is reachable only under the FULL profile.
 */
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

/**
 * Resolve the active profile: an explicit value wins, else the env var, else FULL. An unknown value
 * fails open to FULL (documented) so a typo never silently hides tools.
 */
export function resolveToolProfile(explicit?: string): ToolProfile {
  const raw = explicit ?? process.env[TOOL_PROFILE_ENV];
  return raw === TOOL_PROFILE.CORE ? TOOL_PROFILE.CORE : TOOL_PROFILE.FULL;
}

/** Apply a profile to the tool list. CORE keeps only the core set; FULL passes everything through. */
export function filterTools(tools: ToolDef[], profile: ToolProfile): ToolDef[] {
  return profile === TOOL_PROFILE.CORE ? tools.filter((t) => CORE_TOOL_NAMES.has(t.name)) : tools;
}
