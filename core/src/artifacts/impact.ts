import * as z from 'zod';

/**
 * The impact record: what Reticle has actually done for this user, and what that is worth.
 *
 * Everything here is derived from calls that really happened - the dispatch chokepoint counts them
 * - and is stored locally. Two kinds of number live in this file and they are NOT interchangeable:
 *
 *   MEASURED  - counted from real calls (tokens returned, verdicts, defects, sessions, minutes).
 *   ESTIMATED - a comparison against a run that did not happen (tokens/minutes SAVED). Every one of
 *               these carries the baseline it is measured against, because a saving without its
 *               denominator is not a claim, it is a slogan - and this project has already been
 *               bitten by publishing one ("2574x cheaper" compares against an LLM re-drive, not a
 *               compiled suite).
 *
 * The UI must render the two differently and must never present an estimate as a count.
 */

/** Storage + wire version for the impact record. Bump on any breaking shape change. */
export const IMPACT_SCHEMA_VERSION = 1;

/** How many daily buckets a store keeps - enough for a month's chart plus a fortnight of slack. */
export const IMPACT_DAILY_BUCKETS = 45;

/** Counts of things that actually happened. Every field is a tally, never an estimate. */
export const ImpactCountsSchema = z.object({
  /** Session-bound tool calls that reached a handler. */
  calls: z.number().int().nonnegative(),
  /** Calls that produced a verdict (act_and_wait / assert). */
  verdicts: z.number().int().nonnegative(),
  /** Verdicts that came back verified:"yes". */
  passed: z.number().int().nonnegative(),
  /** Verdicts that came back verified:"no" - a defect the agent would otherwise have called done. */
  failed: z.number().int().nonnegative(),
  /** Verdicts Reticle could not decide. Shown, not hidden: an unknown is not a pass. */
  unknown: z.number().int().nonnegative(),
  /** Refusals - a drive Reticle declined rather than faking. */
  refusals: z.number().int().nonnegative(),
  /** Notes a human pinned to the page. */
  marks: z.number().int().nonnegative(),
  /** Distinct sessions seen. */
  sessions: z.number().int().nonnegative(),
  /** Tokens Reticle returned to the agent (estimated per call at ~4 chars/token, then summed). */
  tokensReturned: z.number().int().nonnegative(),
  /** Wall-clock milliseconds spent inside tool calls. */
  drivingMs: z.number().int().nonnegative(),
});
export type ImpactCounts = z.infer<typeof ImpactCountsSchema>;

/** One day's slice of the same counters, keyed by ISO date, for the chart. */
export const ImpactDaySchema = z.object({
  /** YYYY-MM-DD, local to the machine that recorded it. */
  date: z.string(),
  counts: ImpactCountsSchema,
});
export type ImpactDay = z.infer<typeof ImpactDaySchema>;

/** Bests worth beating. Gamification, entirely local. */
export const ImpactRecordsSchema = z.object({
  /** Longest single session, in ms. */
  longestRunMs: z.number().int().nonnegative(),
  /** Most verdicts in one day. */
  bestVerdictDay: z.number().int().nonnegative(),
  /** Most defects caught in one day. */
  bestDefectDay: z.number().int().nonnegative(),
  /** Consecutive days with at least one verdict, up to and including today. */
  streakDays: z.number().int().nonnegative(),
  /** Longest such streak ever. */
  bestStreakDays: z.number().int().nonnegative(),
});
export type ImpactRecords = z.infer<typeof ImpactRecordsSchema>;

/**
 * A saving, with the comparison that produced it.
 *
 * `basis` names what the number is measured AGAINST, in the user's own words, and it is rendered
 * next to the figure. No basis, no number.
 */
export const ImpactEstimateSchema = z.object({
  value: z.number().nonnegative(),
  basis: z.string(),
});
export type ImpactEstimate = z.infer<typeof ImpactEstimateSchema>;

export const ImpactSavingsSchema = z.object({
  /** Tokens not spent, vs looking at the app the way an agent without Reticle has to. */
  tokens: ImpactEstimateSchema,
  /** Minutes not spent, vs the re-prompt cycle a false green costs. */
  minutes: ImpactEstimateSchema,
});
export type ImpactSavings = z.infer<typeof ImpactSavingsSchema>;

/**
 * How many recent defects a scope remembers.
 *
 * Small on purpose. `counts.failed` already says HOW MANY defects there have been; this list exists
 * so the HUD can say WHICH ONES, and a panel in the corner of somebody's app is not a triage queue.
 * Ten is enough to recognise what is currently broken and short enough that the record stays a
 * counters file rather than becoming a log.
 */
export const IMPACT_DEFECT_LIMIT = 10;

/**
 * One defect, as the HUD shows it.
 *
 * Recorded at the moment a verdict comes back verified:"no" - so it is a thing that actually failed
 * a declared consequence, never a heuristic read of the page afterwards.
 */
export const ImpactDefectSchema = z.object({
  /** When it was caught (epoch ms). */
  at: z.number().int().nonnegative(),
  /** One line naming what failed, in the words the verdict used. */
  title: z.string(),
  /** Why it failed, when the verdict said. */
  detail: z.string().optional(),
  /** `file:line` of the element that was acted on, so the reader can go straight there. */
  source: z.string().optional(),
});
export type ImpactDefect = z.infer<typeof ImpactDefectSchema>;

/** One scope of the record: this project, or everything on this machine. */
export const ImpactScopeSchema = z.object({
  counts: ImpactCountsSchema,
  days: z.array(ImpactDaySchema),
  records: ImpactRecordsSchema,
  savings: ImpactSavingsSchema,
  /** When this scope first recorded anything (epoch ms). */
  since: z.number().int().nonnegative(),
  /**
   * The most recent defects, newest first. Defaulted rather than required: a record written by an
   * older build has no such field, and a counters file that fails to parse loses the whole history.
   */
  defects: z.array(ImpactDefectSchema).default([]),
});
export type ImpactScope = z.infer<typeof ImpactScopeSchema>;

/** What the HUD receives: this project, and the machine-wide total. */
/**
 * Whether this machine is signed in to a Reticle workspace, as the HUD is allowed to know it.
 *
 * Deliberately small, because it is pushed to a BROWSER: a token here would be a token in the DOM of
 * the user's own app, readable by anything else running on it. There is no field for one and the
 * reader is tested for never emitting one.
 *
 * `org`, `email` and `host` are present only when signed in. `host` matters because a self-hosted
 * install is not app.reticle.sh, and telling that user to visit a host they do not use is worse than
 * silence.
 *
 * `email` IS personal data, and it is here because a capsule that cannot name who you are does not
 * answer the question it exists to answer -- an org name is shared by a whole team. It is rendered
 * only inside the account menu, never in the always-visible capsule, so it reaches the DOM on the
 * same terms as the org name and no sooner. It stays OPTIONAL because no cloud sends it yet: the
 * device flow returns `{ status, token, org }` and the session file stores `{ url, token, orgName }`,
 * so today every reader takes the absent branch.
 */
export const AccountStateSchema = z.object({
  signedIn: z.boolean(),
  org: z.string().optional(),
  email: z.string().optional(),
  host: z.string().optional(),
});
export type AccountState = z.infer<typeof AccountStateSchema>;

/** The grant credits came from: sign-up, the card-started trial, or a paid plan. */
export const CreditKind = { FREE: 'free', TRIAL: 'trial', PAID: 'paid' } as const;
export type CreditKind = (typeof CreditKind)[keyof typeof CreditKind];

/**
 * What the platform says about autonomous driving for this project.
 *
 * Mirrors `PlatformModelConfig` on the server side; both are the same wire answer read by different
 * layers. Kept here because it crosses daemon -> browser, which is what makes it a wire type.
 */
export const HarnessConfigSchema = z.object({
  provider: z.string(),
  /** The switch somebody set. Off for a new project: the Harness is opt-in. */
  harnessEnabled: z.boolean(),
  /** Whether this workspace may drive on OUR model spend. Never folded into the switch. */
  harnessEntitled: z.boolean(),
  /** Whether the selected provider has a usable platform key. Older daemons may omit it. */
  providerReady: z.boolean().optional(),
  /** Credits used and held this 30 days; a Harness decision is one. Absent: unbounded or unknown. */
  credits: z
    .object({
      // Not `.int()`: the platform charges part credits (a check can cost 0.25). One float here
      // failed the whole impact snapshot, and the HUD then showed no account and no Harness at all.
      used: z.number().min(0),
      limit: z.number().min(0),
      /** The grant they came from. Optional on the wire: an older platform omits it. */
      kind: z.enum([CreditKind.FREE, CreditKind.TRIAL, CreditKind.PAID]).optional(),
      /** Whole days the grant has left, counted by the daemon from the platform's end date. */
      daysLeft: z.number().int().min(0).optional(),
    })
    .optional(),
  /** The platform this answer came from, so the HUD's links go there and not to the hosted one. */
  platformUrl: z.string().optional(),
  /**
   * The console's page for credits and the trial. The API and the console are two origins, so a
   * link built from `platformUrl` opened a 404. The HUD links here, and to this origin for set-up.
   */
  planUrl: z.string().optional(),
  /** The plan in force: which grant, trial days left, seats. Absent from a platform that sent none. */
  plan: z
    .object({
      kind: z.enum([CreditKind.FREE, CreditKind.TRIAL, CreditKind.PAID]),
      daysLeft: z.number().int().min(0).optional(),
      seats: z.number().int().min(0).optional(),
    })
    .optional(),
  /** Harness runs the platform holds for this project. Absent: the platform did not say. */
  harnessRuns: z.number().int().min(0).optional(),
  /** Memory entries the platform holds for this project. Absent: the platform did not say. */
  memoryEntries: z.number().int().min(0).optional(),
});
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

/** How many of a running drive's latest lines the snapshot carries for the Harness page's log. */
export const HARNESS_LINES_MAX = 60;

/**
 * The Harness drive running in this tab's project, so the panel can show progress and Stop.
 *
 * `lines` is the drive's step log, held by the daemon: kept in the HUD's view alone, it was empty
 * after the Harness page was closed and reopened, or the page reloaded, mid-run.
 */
export const HarnessDriveSchema = z.object({
  runId: z.string(),
  steps: z.number().int().min(0),
  lines: z.array(z.string()).max(HARNESS_LINES_MAX).optional(),
});
export type HarnessDrive = z.infer<typeof HarnessDriveSchema>;

/**
 * This tab's last word from the Harness once nothing is driving: the finished run's result page,
 * and, when it did not run to its end, why (stopped by a reload, refused, the cloud unreachable).
 */
export const LastDriveSchema = z.object({
  runUrl: z.string().optional(),
  said: z.string().optional(),
  /** Which word this is, rising: the page tells the answer to its press from an earlier word. */
  seq: z.number().int().min(0).optional(),
});
export type LastDrive = z.infer<typeof LastDriveSchema>;

/** The longest note a person can send their coding agent from the HUD. */
export const AGENT_NOTE_MAX = 500;
/** How many of a tab's latest notes the HUD shows. */
export const AGENT_NOTES_SHOWN = 5;
const AGENT_LABEL_MAX = 64;

/** A note sent to the coding agent from this tab. `seen` only once an agent's tool call took it. */
export const AgentNoteSchema = z.object({
  text: z.string().max(AGENT_NOTE_MAX),
  seen: z.boolean(),
  /** Which agent took it, when the daemon knows. */
  by: z.string().max(AGENT_LABEL_MAX).optional(),
});
export type AgentNote = z.infer<typeof AgentNoteSchema>;

/** The coding agents attached to the daemon now (friendly names), and this tab's latest notes. */
export const AgentLinkSchema = z.object({
  agents: z.array(z.string().max(AGENT_LABEL_MAX)).max(8),
  notes: z.array(AgentNoteSchema).max(AGENT_NOTES_SHOWN),
});
export type AgentLink = z.infer<typeof AgentLinkSchema>;

export const ImpactSnapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  project: ImpactScopeSchema,
  global: ImpactScopeSchema,
  /** Project name, for the report's title row. */
  projectName: z.string().optional(),
  /**
   * Where the full, triageable list of these defects lives - present only when this project is
   * linked to a Reticle Cloud workspace. Absent is the normal case and the HUD simply shows its
   * short list without a link: the free tool is complete on its own.
   */
  dashboardUrl: z.string().optional(),
  /**
   * Whether this machine is signed in. Absent on an SDK/daemon pair too old to send it, which the
   * HUD must read as "unknown", never as "signed out" — prompting a signed-in user to sign in is the
   * kind of nag that gets a dev-only HUD switched off for good.
   */
  account: AccountStateSchema.optional(),
  /**
   * The harness switch and whether this workspace may drive on our spend.
   *
   * Two fields, never one, and the HUD renders them differently: `harnessEnabled` is a switch the
   * person owns, `harnessEntitled` is a fact about their account. A panel that collapsed them would
   * show "off" to somebody whose free months lapsed and invite them to turn on something they no
   * longer have.
   *
   * Absent means the daemon has not heard -- an offline machine, an unlinked project, an older
   * platform -- and the panel shows no control at all rather than guessing. Showing a switch that
   * cannot be honoured is worse than showing none.
   */
  harnessConfig: HarnessConfigSchema.optional(),
  /** The drive running now, when there is one. Absent: nothing is driving. */
  harnessDrive: HarnessDriveSchema.optional(),
  /** How the last drive on this tab ended, or why none started. Absent while one drives. */
  lastDrive: LastDriveSchema.optional(),
  /** Who is coding against this daemon, and what this tab said to them. Absent: an older daemon. */
  agent: AgentLinkSchema.optional(),
  /**
   * The rail's notices, already chosen for this machine by the daemon (see `hud-notices.ts`).
   * Absent means the daemon has nothing newer than the SDK's bundled slides, which then show.
   *
   * Loose here on purpose: this schema is on every page's first load, and the full notice schema
   * (link rules, id pattern) is not. The lazily loaded panel validates each notice with
   * `HudNoticeSchema` from `@reticlehq/core/hud` before rendering it.
   */
  notices: z.array(z.unknown()).max(8).optional(),
  /**
   * Reticle Coverage: each level's percentage from the project's coverage ledger (`reached` routes,
   * `proved` controls, `executed` code, ...). Numbers only. Absent until something was measured.
   */
  coverage: z.record(z.string(), z.number()).optional(),
  /**
   * Where this project's work stands with the platform (status, runs on it, waiting, refused, last
   * push, and the sentence describing it). Loose here, shaped by the daemon's sync-status.
   */
  sync: z.record(z.string(), z.unknown()).optional(),
  /**
   * How much of THIS tab's app Reticle sees, and the prompt that asks a coding agent to close the
   * rest (`covered`, `total`, `missing`, `prompt`). Loose here, shaped by the daemon's coverageOf.
   */
  instrumentation: z.record(z.string(), z.unknown()).optional(),
});
export type ImpactSnapshot = z.infer<typeof ImpactSnapshotSchema>;

/** Empty counters - the starting point for a fresh store and the identity for merges. */
export function emptyImpactCounts(): ImpactCounts {
  return {
    calls: 0,
    verdicts: 0,
    passed: 0,
    failed: 0,
    unknown: 0,
    refusals: 0,
    marks: 0,
    sessions: 0,
    tokensReturned: 0,
    drivingMs: 0,
  };
}

export function emptyImpactRecords(): ImpactRecords {
  return {
    longestRunMs: 0,
    bestVerdictDay: 0,
    bestDefectDay: 0,
    streakDays: 0,
    bestStreakDays: 0,
  };
}

/** Add one delta into a running total. Pure; the store owns persistence. */
export function addImpactCounts(base: ImpactCounts, delta: Partial<ImpactCounts>): ImpactCounts {
  const out = { ...base };
  for (const key of Object.keys(out) as (keyof ImpactCounts)[]) {
    out[key] = out[key] + (delta[key] ?? 0);
  }
  return out;
}
