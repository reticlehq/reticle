/**
 * The link between a person's daemon and the Reticle platform: what each says to the other.
 *
 * The platform deploys any day; the daemon only changes when somebody upgrades it. So this contract
 * is built to let a newer platform ask an older daemon for things, and an older platform keep working
 * with a newer daemon:
 *
 * - The daemon says which version of this link it speaks and what it can do (`LinkCapability`), on
 *   every report. The platform offers a person only what their machine said it can do, and never
 *   infers a capability from a version number.
 * - A drive arrives with a `DriveSpec`. Every field is read on its own; one the daemon does not know,
 *   or cannot honour, is reported back as ignored with a reason. A drive never fails because the
 *   platform asked for more than this daemon understands.
 * - A drive in `platform` mode is a tool session: the platform decides every step and the daemon
 *   only runs Reticle's own tools and returns their raw results. Planning, personas, repeats for
 *   flakiness, judging and the summary all live on the platform, so they change without a release.
 *
 * Every arrow points out from the daemon: it asks, the platform answers. Nothing listens for the
 * platform on the person's machine.
 */
import { z } from 'zod';
import { HudVisibility } from './constants/hud-use.js';

/** Bumped only for a change an older reader would MISREAD. A new field is not one. */
export const PLATFORM_LINK_VERSION = 1;

/** What a daemon can do for the platform, as it reports it. */
export const LinkCapability = {
  /** Reads a `DriveSpec`, and reports what it applied and what it ignored. */
  DRIVE_SPEC: 'drive-spec',
  /** Drives the person's own open tab. */
  TARGET_TAB: 'target:tab',
  /** Opens the app in a browser of its own with no window. */
  TARGET_HEADLESS: 'target:headless',
  /** Opens the app in a browser window the person can watch. */
  TARGET_HEADED: 'target:headed',
  /** Shows, hides or removes the HUD on the page it drives. */
  HUD: 'hud',
  /** Runs a drive the platform orchestrates, one batch of tool calls at a time. */
  TOOL_SESSION: 'tool-session',
  /** Sends pictures of the page while it drives. */
  FRAMES: 'frames',
} as const;
export type LinkCapability = (typeof LinkCapability)[keyof typeof LinkCapability];

/** Where a drive runs. */
export const DriveTarget = {
  /** A tab the person already has open. Their HUD shows it happening. */
  TAB: 'tab',
  /** A fresh browser context with no window. */
  HEADLESS: 'headless',
  /** A fresh browser window on the person's screen. */
  HEADED: 'headed',
} as const;
export type DriveTarget = (typeof DriveTarget)[keyof typeof DriveTarget];

/** Who decides each step of a drive. */
export const DriveMode = {
  /** The daemon's own Harness plans and judges it. What every daemon before this link did. */
  LOCAL: 'local',
  /** The platform decides every step over a tool session; the daemon only runs tools. */
  PLATFORM: 'platform',
} as const;
export type DriveMode = (typeof DriveMode)[keyof typeof DriveMode];

/** Why a field of a spec was not applied. */
export const SpecIgnoredReason = {
  /** This daemon does not know the field: the platform is newer. */
  UNKNOWN: 'unknown',
  /** The value did not read as the field's type. */
  INVALID: 'invalid',
  /** Known and valid, but this machine cannot do it right now (no browser, no HUD on the page). */
  UNAVAILABLE: 'unavailable',
} as const;
export type SpecIgnoredReason = (typeof SpecIgnoredReason)[keyof typeof SpecIgnoredReason];

const PERSONA_MAX = 2_000;
const STEPS_MAX = 500;

/** Each field of a spec, validated on its own so one bad field never costs the others. */
const SPEC_FIELDS = {
  target: z.enum([DriveTarget.TAB, DriveTarget.HEADLESS, DriveTarget.HEADED]),
  mode: z.enum([DriveMode.LOCAL, DriveMode.PLATFORM]),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:/i.test(u)),
  hud: z.enum([HudVisibility.SHOWN, HudVisibility.HIDDEN, HudVisibility.REMOVED]),
  persona: z.string().min(1).max(PERSONA_MAX),
  maxSteps: z.number().int().min(1).max(STEPS_MAX),
  record: z.boolean(),
} as const;

export interface DriveSpec {
  target?: DriveTarget;
  mode?: DriveMode;
  /** The address to open, for a target that opens one. Absent: the app's own last address. */
  url?: string;
  hud?: HudVisibility;
  persona?: string;
  maxSteps?: number;
  /** Whether pictures of the page may leave the machine. */
  record?: boolean;
}

export interface SpecIgnored {
  field: string;
  reason: SpecIgnoredReason;
  /** Why, in a person's words, when there is more to say than the reason. */
  detail?: string;
}

/**
 * Read a spec as far as it can be read. Never throws: a field that does not validate, or that this
 * daemon does not know, is reported in `ignored` and the rest still apply.
 */
export function parseDriveSpec(raw: unknown): { spec: DriveSpec; ignored: SpecIgnored[] } {
  const ignored: SpecIgnored[] = [];
  const spec: Record<string, unknown> = {};
  if ('object' !== typeof raw || null === raw || Array.isArray(raw)) return { spec, ignored };
  for (const [field, value] of Object.entries(raw)) {
    const schema = (SPEC_FIELDS as Record<string, z.ZodTypeAny>)[field];
    if (schema === undefined) {
      ignored.push({ field, reason: SpecIgnoredReason.UNKNOWN });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) spec[field] = parsed.data;
    else ignored.push({ field, reason: SpecIgnoredReason.INVALID });
  }
  return { spec, ignored };
}

/** What a daemon did with a spec, sent back with the drive's result or its first session ask. */
export interface DriveApplied {
  target: DriveTarget;
  mode: DriveMode;
  url?: string;
  hud?: HudVisibility;
  /** The tab the drive ran in. */
  sessionId?: string;
}

/** One tool call the platform asks the daemon to run. */
export interface ToolSessionCall {
  seq: number;
  tool: string;
  args: Record<string, unknown>;
}

/** How one call went, as the daemon ran it. `result` is the tool's own answer, unedited. */
export interface ToolSessionResult {
  seq: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  ms: number;
}

/** The platform's answer to a session ask: the next calls, or that the drive is over. */
export interface ToolSessionReply {
  calls: ToolSessionCall[];
  done: boolean;
}

/** Bounds a daemon holds a tool session to, whatever the platform asks. */
export const TOOL_SESSION_LIMITS = {
  /** Calls one drive may make in all: a loop on the platform must not drive forever. */
  MAX_CALLS: 1_000,
  /** Calls taken from one answer; the rest are not run. */
  MAX_BATCH: 25,
  /**
   * Times one ask is sent again after the network or the platform failed it. The SAME ask, under
   * the same `ask` number, so the platform answers it once: a resend never advances the drive twice.
   */
  RETRIES: 4,
  /** The first wait before asking again; it doubles each time (0.5s, 1s, 2s, 4s). */
  RETRY_BASE_MS: 500,
} as const;

/**
 * Whether an ask that came back with this status is worth sending again: the platform or the network
 * failed it (5xx, 429, 408). A refusal (4xx) is the platform's answer, and asking again changes nothing.
 */
export const sessionAskRetryable = (status: number): boolean =>
  500 <= status || 429 === status || 408 === status;

const SessionCallSchema = z.object({
  seq: z.number().int().nonnegative(),
  tool: z.string().min(1).max(100),
  args: z.record(z.unknown()).default({}),
});

/**
 * Read the platform's answer. Never throws: an answer that does not read is "done", because a drive
 * that cannot understand its orders must stop rather than guess. A call that does not read is
 * dropped; the platform sees no result for its `seq` and decides what that means.
 */
export function parseToolSessionReply(raw: unknown): ToolSessionReply {
  if ('object' !== typeof raw || null === raw) return { calls: [], done: true };
  const record = raw as { calls?: unknown; done?: unknown };
  const calls = (Array.isArray(record.calls) ? record.calls : [])
    .slice(0, TOOL_SESSION_LIMITS.MAX_BATCH)
    .flatMap((call) => {
      const parsed = SessionCallSchema.safeParse(call);
      return parsed.success ? [parsed.data] : [];
    });
  return { calls, done: true === record.done || 0 === calls.length };
}

/** How much a platform notice matters to the person reading it. */
export const LinkNoticeLevel = {
  INFO: 'info',
  WARN: 'warn',
  /** Their Reticle is older than what the platform can use: what to run to update it. */
  UPDATE: 'update',
} as const;
export type LinkNoticeLevel = (typeof LinkNoticeLevel)[keyof typeof LinkNoticeLevel];

/**
 * Something the platform tells the person through their daemon: "update Reticle to drive with every
 * option". The one way a platform reaches a daemon it cannot change, so it is kept to a sentence.
 */
export interface LinkNotice {
  level: LinkNoticeLevel;
  text: string;
  url?: string;
}

export const LINK_NOTICE_MAX = 3;
export const LINK_NOTICE_TEXT_MAX = 300;

/** Read the platform's notices; one that does not read is dropped, never shown half-read. */
export function parseLinkNotices(raw: unknown): LinkNotice[] {
  const levels = new Set<string>(Object.values(LinkNoticeLevel));
  return (Array.isArray(raw) ? raw : [])
    .flatMap((entry): LinkNotice[] => {
      if ('object' !== typeof entry || null === entry) return [];
      const notice = entry as { level?: unknown; text?: unknown; url?: unknown };
      const text = 'string' === typeof notice.text ? notice.text.trim() : '';
      if ('string' !== typeof notice.level || !levels.has(notice.level) || 0 === text.length)
        return [];
      const url =
        'string' === typeof notice.url && /^https?:\/\//i.test(notice.url) ? notice.url : undefined;
      return [
        {
          level: notice.level as LinkNoticeLevel,
          text: text.slice(0, LINK_NOTICE_TEXT_MAX),
          ...(url === undefined ? {} : { url }),
        },
      ];
    })
    .slice(0, LINK_NOTICE_MAX);
}

/** The platform's paths the daemon calls, all with its machine key. */
export const LinkPath = {
  /** The apps this machine has connected; answered with apps to open and whether a drive waits. */
  APPS: '/v1/harness/local-apps',
  /** The next drive for this project, or null. */
  NEXT_DRIVE: '/v1/harness/local-drives/next',
  /** How a drive ended. */
  driveResult: (id: string): string => `/v1/harness/local-drives/${encodeURIComponent(id)}`,
  /** A picture of the driven page. */
  driveFrames: (id: string): string => `/v1/harness/local-drives/${encodeURIComponent(id)}/frames`,
  /** One turn of a tool session: results in, next calls out. */
  driveSession: (id: string): string =>
    `/v1/harness/local-drives/${encodeURIComponent(id)}/session`,
} as const;

/**
 * What a daemon adds to each local-apps report so the platform can say what an app is missing and
 * why a page never connected. Every key is additive: a platform that predates one ignores it.
 */
export const LinkReportKey = {
  /** Per app: the channels its page announced in its HELLO. */
  CHANNELS: 'channels',
  /** Per app: instrumentation gaps its verdicts recorded, deduped by kind + missing, newest first. */
  GAPS: 'gaps',
  /** Per app: the framework adapters its page announced. */
  ADAPTERS: 'adapters',
  /** Top level: dev servers listening on this machine that no Reticle page has connected from. */
  DEV_SERVERS: 'devServers',
  /** Top level: the last page handshake this daemon refused, and why. */
  HELLO_FAILURE: 'helloFailure',
  /** Top level: `.reticle` folders holding runs that never reached the platform. */
  UNSYNCED: 'unsynced',
} as const;

/** How many recorded gaps one app reports. */
export const LINK_APP_GAPS_MAX = 20;

/** One recorded instrumentation gap, as an app report carries it. */
export interface LinkAppGap {
  kind: string;
  missing: string;
  fix: string;
  seenAt: number;
}

/** A dev server listening on localhost with no connected Reticle page. */
export interface LinkDevServer {
  url: string;
  port: number;
}

/** The last refused page handshake: version skew, token, port or protocol, in `reason`. */
export interface LinkHelloFailure {
  reason: string;
  at: number;
  sdkVersion?: string;
}

/** A `.reticle` folder with runs that never reached the platform. `root` is `~`-relative. */
export interface LinkUnsyncedRoot {
  root: string;
  runs: number;
  linked: boolean;
}

/**
 * Markers a daemon adds to an app's `channels` beside the protocol channel ids, for the two
 * capabilities no channel names. Sent only on evidence, never while the gap that names the same
 * capability is recorded: absence of both reads as "not seen yet", never as covered.
 */
export const CoverageMarker = {
  /** The page carries `data-reticle-source` (the build plugin is active). */
  SOURCE: 'source',
  /** The app's snapshots show `data-testid` on its controls. */
  TESTID: 'testid',
} as const;
export type CoverageMarker = (typeof CoverageMarker)[keyof typeof CoverageMarker];
