/**
 * The product signals the event set could not answer: who is signed in, which workspace and which
 * agent client an event belongs to, which HUD page was opened, which sign-in prompts were seen, when a
 * project was linked, how a Harness run started and ended, and what happened to the MCP proxy and
 * its daemon when the link failed.
 *
 * Its own file so the vocabulary has one home and `telemetry.ts` only wires it in. Every value here is
 * a closed set, a boolean or a bucket: none of these fields can carry a URL, a path, a name or text.
 */
import * as z from 'zod';
import { HudPanel, HudPromptSurface } from './wire/constants/hud-use.js';

/**
 * Where this machine stands with the platform, on every event. `linked` implies signed in OR an
 * api key in the environment: a project with a working link reports to a workspace either way.
 */
export const TelemetryAccountState = {
  SIGNED_OUT: 'signed_out',
  SIGNED_IN: 'signed_in',
  LINKED: 'linked',
} as const;
export type TelemetryAccountState =
  (typeof TelemetryAccountState)[keyof typeof TelemetryAccountState];

/**
 * Which coding agent an event came from, normalised from the MCP handshake's `clientInfo.name`, else
 * from a marker the agent sets in the environment of what it spawns. `other` is a client that named
 * itself and is not on this list; absent means nothing said.
 */
export const AgentClient = {
  CLAUDE_CODE: 'claude_code',
  CLAUDE_DESKTOP: 'claude_desktop',
  CODEX: 'codex',
  CURSOR: 'cursor',
  GEMINI_CLI: 'gemini_cli',
  ANTIGRAVITY: 'antigravity',
  WINDSURF: 'windsurf',
  CLINE: 'cline',
  OPENCODE: 'opencode',
  ZED: 'zed',
  VSCODE: 'vscode',
  OTHER: 'other',
} as const;
export type AgentClient = (typeof AgentClient)[keyof typeof AgentClient];

/**
 * How the running `reticle` was launched, read from where its own entry script sits: an npx cache,
 * a global install, or a project's `node_modules`. Only the bucket leaves the machine, never the path.
 * It is not the install CHANNEL (`installSource`): every channel can end in any of these.
 */
export const LaunchMethod = {
  NPX: 'npx',
  GLOBAL: 'global',
  PROJECT: 'project',
  OTHER: 'other',
} as const;
export type LaunchMethod = (typeof LaunchMethod)[keyof typeof LaunchMethod];

/** A count, bucketed: an exact number of tabs or journeys starts to describe one app. */
export const CountBucket = {
  ZERO: '0',
  ONE: '1',
  TWO_THREE: '2-3',
  FOUR_NINE: '4-9',
  TEN_PLUS: '10+',
} as const;
export type CountBucket = (typeof CountBucket)[keyof typeof CountBucket];

export function countBucket(n: number): CountBucket {
  if (n <= 0) return CountBucket.ZERO;
  if (1 === n) return CountBucket.ONE;
  if (n <= 3) return CountBucket.TWO_THREE;
  if (n <= 9) return CountBucket.FOUR_NINE;
  return CountBucket.TEN_PLUS;
}

/** `hud_viewed` / `hud_signin_prompted`: which page or prompt, and how many tabs had a HUD. */
export const HudEventSchema = z.object({
  view: z.nativeEnum(HudPanel).optional(),
  surface: z.nativeEnum(HudPromptSurface).optional(),
  tabs: z.nativeEnum(CountBucket).optional(),
});
export type HudEvent = z.infer<typeof HudEventSchema>;

/** How a project got linked to a workspace on this machine. */
export const PlatformLinkVia = {
  /** `reticle connect`: sign in, link and sync in one command. */
  CONNECT: 'connect',
  /** The HUD's "Link this project" / "Save runs for your team". */
  HUD: 'hud',
  /** A bare `reticle link`. */
  LINK: 'link',
} as const;
export type PlatformLinkVia = (typeof PlatformLinkVia)[keyof typeof PlatformLinkVia];

export const PlatformLinkSchema = z.object({ via: z.nativeEnum(PlatformLinkVia) });
export type PlatformLink = z.infer<typeof PlatformLinkSchema>;

export const HarnessRunPhase = { STARTED: 'started', COMPLETED: 'completed' } as const;
export type HarnessRunPhase = (typeof HarnessRunPhase)[keyof typeof HarnessRunPhase];

/** How a Harness run ended. `blocked` is a refusal before it drove (gate, credits, switched off). */
export const HarnessRunOutcome = {
  PROVED: 'proved',
  NOT_PROVED: 'not_proved',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  STOPPED: 'stopped',
} as const;
export type HarnessRunOutcome = (typeof HarnessRunOutcome)[keyof typeof HarnessRunOutcome];

/**
 * Why a Harness run did not drive: only on a `blocked` or `failed` run. Closed, and read off the
 * refusal that stopped it, never off its sentence, so a reworded message cannot change the count.
 */
export const HarnessRunReason = {
  /** The project has no platform link, so there is nowhere to drive from. */
  NOT_LINKED: 'not_linked',
  /** The platform did not confirm the drive in time, or answered something unreadable. */
  PLATFORM_UNREACHABLE: 'platform_unreachable',
  /** The Harness is switched off for this project (the default until somebody turns it on). */
  HARNESS_OFF: 'harness_off',
  /** The workspace has no credits left. */
  NO_CREDITS: 'no_credits',
  /** The workspace has not claimed the Harness. */
  NOT_ENTITLED: 'not_entitled',
  /** An older build refused for low instrumentation. No longer sent: the Harness has no coverage gate. */
  COVERAGE_GATE: 'coverage_gate',
  /** The page and the daemon come from different builds, so every step would answer unknown. */
  VERSION_SKEW: 'version_skew',
  /** The drive started and broke. */
  BROKEN: 'broken',
  /** A refusal this list does not name. A growing count here is a gap in this list. */
  OTHER: 'other',
} as const;
export type HarnessRunReason = (typeof HarnessRunReason)[keyof typeof HarnessRunReason];

/** Who started a Harness run. `dashboard` is a run started from the platform's chat. */
export const HarnessRunSource = {
  AGENT: 'agent',
  HUD: 'hud',
  DASHBOARD: 'dashboard',
  CLI_TRY: 'cli_try',
  PLAN: 'plan',
} as const;
export type HarnessRunSource = (typeof HarnessRunSource)[keyof typeof HarnessRunSource];

/** `harness_run`: one `started` and one `completed` per run. */
export const HarnessRunSchema = z.object({
  phase: z.nativeEnum(HarnessRunPhase),
  source: z.nativeEnum(HarnessRunSource),
  /** The run drives on the platform (always, today), as opposed to an injected local driver. */
  hosted: z.boolean(),
  /** Only on `completed`. */
  outcome: z.nativeEnum(HarnessRunOutcome).optional(),
  /** Only on `completed`: journeys the run answered, and how many of those replayed with no model. */
  journeys: z.nativeEnum(CountBucket).optional(),
  replayed: z.nativeEnum(CountBucket).optional(),
  /** Only on a `blocked` or `failed` run: why it did not drive. */
  reason: z.nativeEnum(HarnessRunReason).optional(),
});
export type HarnessRun = z.infer<typeof HarnessRunSchema>;

/**
 * The envelope fields and blocks this file adds to `TelemetryEventSchema`, spread into it there.
 * Every one optional: an older sender has none of them.
 */
export const SIGNAL_FIELDS = {
  /** Signed out, signed in, or signed in AND this project linked to a workspace. */
  accountState: z.nativeEnum(TelemetryAccountState).optional(),
  /** This project reports to a workspace. */
  linked: z.boolean().optional(),
  /**
   * The platform's id for the linked workspace (`orgId` in `.reticle/cloud.json`): a pseudonymous
   * key the platform joins its own records on. Never the workspace NAME, never an email.
   */
  workspaceId: z.string().min(1).max(128).optional(),
  /** Which coding agent this event came from, normalised. Absent when nothing said. */
  client: z.nativeEnum(AgentClient).optional(),
  /** How the running `reticle` was launched. */
  launch: z.nativeEnum(LaunchMethod).optional(),
  /** Only on `hud_viewed` / `hud_signin_prompted`. */
  hud: HudEventSchema.optional(),
  /** Only on `platform_linked`. */
  link: PlatformLinkSchema.optional(),
  /** Only on `harness_run`. */
  harness: HarnessRunSchema.optional(),
};

// ── Transport: what happens to the MCP proxy and its daemon when the link fails ──
// No block below carries a path, a port, a pid or a message.

/**
 * The socket error code behind a drop, as a closed set. Anything else reports `other`, so a new code
 * cannot put free text on the wire.
 */
export const OutageErrCode = {
  ECONNRESET: 'ECONNRESET',
  ECONNREFUSED: 'ECONNREFUSED',
  EPIPE: 'EPIPE',
  ETIMEDOUT: 'ETIMEDOUT',
  OTHER: 'other',
} as const;
export type OutageErrCode = (typeof OutageErrCode)[keyof typeof OutageErrCode];

/** Why the MCP proxy process left. Each member names one exit path in the proxy. */
export const ProxyExitReason = {
  /** The client closed stdin. The normal end of a session. */
  STDIN_END: 'stdin_end',
  /** The client link was quiet for the idle window, with no work in flight. */
  IDLE: 'idle',
  /** Too many client-pipe disconnects since the last usable session: the client is gone. */
  CLIENT_GONE_STORM: 'client_gone_storm',
  /** The proxy could not start a daemon and had no way to continue. */
  WAKE_FAILED: 'wake_failed',
} as const;
export type ProxyExitReason = (typeof ProxyExitReason)[keyof typeof ProxyExitReason];

/** `mcp_proxy_exited`: the agent's MCP server process ended, and the agent lost its tools. */
export const ProxyExitSchema = z.object({
  reason: z.nativeEnum(ProxyExitReason),
  /** How long the proxy process ran. */
  uptimeMs: z.number().int().nonnegative(),
  /** How many times the proxy lost its daemon stream in its life. */
  drops: z.number().int().nonnegative(),
  /** How many `tools/call` requests the client sent through this proxy. */
  toolCalls: z.number().int().nonnegative(),
  proxyId: z.string().min(1).max(64).optional(),
});
export type ProxyExit = z.infer<typeof ProxyExitSchema>;

/** `daemon_died_unclean`: a daemon start found the pidfile of a daemon that never stopped cleanly. */
export const DaemonDeathSchema = z.object({
  /** Time from the dead daemon's start (its pidfile write) to this discovery. */
  ageMs: z.number().int().nonnegative(),
});
export type DaemonDeath = z.infer<typeof DaemonDeathSchema>;

/** How the parent started the daemon. On Windows a start through WMI leaves the Job Object. */
export const DaemonSpawnMethod = {
  /** A detached child of the parent. On Windows it stays in the job of the parent. */
  DETACHED: 'detached',
  /** Windows only: started through WMI `Win32_Process.Create`, outside every job. */
  WMI: 'wmi',
  /** Windows only: the WMI start failed, so the parent used the detached start. */
  WMI_FALLBACK: 'wmi_fallback',
} as const;
export type DaemonSpawnMethod = (typeof DaemonSpawnMethod)[keyof typeof DaemonSpawnMethod];

/** What held the port when a wake was refused. */
export const WakeRefusalPresence = {
  /** Something that is not a Reticle daemon holds the port. */
  FOREIGN: 'foreign',
  /** A Reticle daemon for a different project holds the port. */
  OTHER_PROJECT: 'other_project',
} as const;
export type WakeRefusalPresence = (typeof WakeRefusalPresence)[keyof typeof WakeRefusalPresence];

/** `wake_refused`: the proxy would not use the daemon port it found. */
export const WakeRefusalSchema = z.object({
  presence: z.nativeEnum(WakeRefusalPresence),
});
export type WakeRefusal = z.infer<typeof WakeRefusalSchema>;

/** The blocks this file adds to `TelemetryEventSchema`, spread into it there. */
export const TRANSPORT_FIELDS = {
  /** Only on `mcp_proxy_exited`. */
  proxyExit: ProxyExitSchema.optional(),
  /** Only on `daemon_died_unclean`. */
  daemonDeath: DaemonDeathSchema.optional(),
  /** Only on `wake_refused`. */
  wakeRefusal: WakeRefusalSchema.optional(),
  /** Only on `daemon_started`: how the parent started the daemon. A scalar. */
  spawnMethod: z.nativeEnum(DaemonSpawnMethod).optional(),
};
