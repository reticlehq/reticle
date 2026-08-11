/**
 * Anonymous product telemetry — the contract for how the OSS `reticle` runtime reports ADOPTION
 * (not verification results): is it installed, how often is it invoked, which tools get used, how many
 * distinct machines/projects run it. This is what turns "npm downloads" (which an investor discounts)
 * into DAU/WAU/MAU, active sessions, and retention. Uninstall/churn is deliberately NOT an event —
 * npm 7+/pnpm run no uninstall lifecycle scripts, so churn is inferred server-side from inactivity.
 *
 * Privacy is structural, not a policy: the ONLY identifiers on the wire are a random per-machine UUID
 * (`anonymousId`, minted locally, never derived from anything personal) and a one-way HASH of the
 * project (`projectId`) — no repo name, no path, no email, no code. The ONE exception is the
 * `feedback` event, and it is an exception by consent, not by accident: it carries text a human typed
 * or an agent wrote, it is NEVER emitted passively (only from an explicit `reticle_feedback` call or
 * `reticle feedback` command), and it has its own kill switch. It is strictly opt-OUT (respects
 * `RETICLE_TELEMETRY=0` and the `DO_NOT_TRACK` convention) and best-effort (a failed send never touches
 * the tool's behaviour). Same conventions as the rest of core: enums are `as const` narrowed with
 * `z.nativeEnum`, timestamps are epoch-ms NUMBERS, no `any`.
 */
import { z } from 'zod';
import {
  MachineSnapshotSchema,
  ProjectProfileSchema,
  SessionSummarySchema,
} from './telemetry-session.js';
import { BrowserBrand, FeedbackSchema } from './telemetry-feedback.js';
import { VerifiedReason } from './verified-constants.js';
import { IdentitySchema } from './telemetry-feedback.js';

/** Bump when the event shape changes so the analytics side can segment old senders. */
export const TELEMETRY_EVENT_VERSION = 3;

/**
 * The event taxonomy. Every name says WHAT HAPPENED, in `noun_verbed` form, with no abbreviations —
 * the previous set failed that badly enough to confuse its own authors: `invoke` sounded like "a tool
 * was invoked" but meant "the CLI binary ran", while the event that actually meant a tool call was
 * `tool`, emitted from a file called `invoke-tool.ts`. A name you have to look up is a name that gets
 * misread on a dashboard six months from now.
 *
 * VOLUME IS PART OF THE DESIGN. PostHog bills per ingested event, so the taxonomy is deliberately
 * shaped around one high-frequency thing (tool calls) being AGGREGATED rather than emitted. A single
 * agent verification loop is 50–200 tool calls; at one event each, a thousand users would push
 * millions of events a day for a question — "which tools get used" — that one summary property
 * answers better, because it also preserves the SHAPE of a session instead of scattering it across
 * 200 rows. See `SessionSummary`.
 */
export const TelemetryEventKind = {
  /** First-ever run on this machine — powers install count + the new-user curve. */
  RETICLE_INSTALLED: 'reticle_installed',
  /**
   * A human ran a `reticle` subcommand. Carries WHICH command, which is the closest honest read we
   * have on human intent (`verify` and `gate` mean something very different from `status`).
   *
   * Explicitly NOT emitted for the internal `_daemon` spawn: `reticle mcp` re-runs its own binary to
   * start the daemon, so counting that child inflated the old `invoke` metric ~2x — and worst on
   * exactly the agent-driven sessions that matter most, while leaving one-shot commands like
   * `version` untouched. That skewed the ratio, not just the scale.
   */
  CLI_COMMAND_RUN: 'cli_command_run',
  /** The daemon came up — the numerator of active sessions + DAU/WAU/MAU. */
  DAEMON_STARTED: 'daemon_started',
  /**
   * The daemon exited. THE RICH ONE: carries the whole session rolled up (duration, tool histogram,
   * errors, features touched). One event replaces the hundreds the old per-call `tool` event sent.
   */
  DAEMON_STOPPED: 'daemon_stopped',
  /**
   * A PERIODIC roll-up from a daemon that is still running — same payload shape as DAEMON_STOPPED,
   * `final: false`.
   *
   * It used to be emitted AS `daemon_stopped`, which made an event named for an exit fire while the
   * process was alive. Measured over one day: 98 `daemon_stopped` events were 73 real exits plus 25
   * flushes, so anything counting sessions over-stated by 34% — and worse, the two populations are
   * opposites. Every one of the 25 flushes had tool calls; not one of the 73 exits did (a daemon that
   * served a tool never idle-exits, so only the idle ones ever reach a clean shutdown). A funnel over
   * the raw event therefore describes active sessions at one end and abandoned ones at the other.
   *
   * Count sessions with DAEMON_STOPPED. Sum work with both.
   */
  SESSION_PROGRESS: 'session_progress',
  /**
   * A verification produced a verdict. The product's reason to exist, and the one metric an investor
   * should be shown: not "tools were called" but "an app was actually verified, and here is how often
   * that caught something a green test would have missed".
   */
  VERIFICATION_COMPLETED: 'verification_completed',
  /**
   * A snapshot of the project Reticle is pointed at — stack, size, and how DEEPLY the feature surface
   * is used. Answers "are they using all of Reticle or three tools of it", which is the difference
   * between a retention problem and an activation problem. Once per daemon start, so it is cheap.
   */
  PROJECT_PROFILED: 'project_profiled',
  /** `reticle update` or `reticle rollback` moved the installed version. Carries from → to. */
  VERSION_CHANGED: 'version_changed',
  /** An uncaught exception or unhandled rejection reached the top of the daemon. Crash analytics. */
  RUNTIME_CRASHED: 'runtime_crashed',
  /**
   * Someone told us something went wrong (or right). UNLIKE every other kind, this one carries
   * author-written free text — which is exactly why it is never emitted passively: it exists only
   * because an agent called `reticle_feedback` or a human ran `reticle feedback`. See
   * `FeedbackSchema` for the consent/redaction contract.
   */
  FEEDBACK_SUBMITTED: 'feedback_submitted',
  /**
   * Someone chose to tell us who they are. Like `feedback_submitted`, this exists ONLY because a
   * human ran a command — Reticle never infers an identity from a git remote, an email in git
   * config, or anything else. See `identify.ts` for why that refusal is deliberate.
   */
  IDENTIFIED: 'identified',
  /**
   * An MCP client attached to the daemon.
   *
   * The one event that separates "Reticle is installed and running" from "somebody is actually using
   * it": a daemon can sit up for days with no agent attached. It also exposes reconnect churn — a
   * client that reattaches every few minutes is a client whose transport is broken, which looks
   * identical to healthy usage in every other metric.
   */
  MCP_CLIENT_CONNECTED: 'mcp_client_connected',
  /**
   * The agent LOST its Reticle tools — the worst thing this product does to anyone, and until now
   * completely invisible in the field.
   *
   * `mcp_client_connected` shows reconnect churn only from the daemon's side, and the proxy's own
   * account of an outage went to a local file nobody sends us. So "how often does a real user's MCP
   * server go down, and does it come back" — the single question the transport has to answer — could
   * not be asked of any dashboard.
   *
   * Deliberately capped at TWO per proxy process: once on the first outage of a session, and once if
   * the retry budget is spent (the severe case, where it stopped retrying and went dormant). The
   * per-call `tool` event was already removed here for cost, and one measured afternoon produced 547
   * proxy reconnects — an event per reconnect would bill for the pathology instead of measuring it.
   * The first-outage event answers "what share of sessions lose MCP at all", which is the number
   * that decides whether this is fixed.
   */
  MCP_CONNECTION_LOST: 'mcp_connection_lost',
  /**
   * `reticle init` finished. The onboarding funnel had no instrumentation at all, so a setup that
   * failed on a missing dependency was indistinguishable from a user who never tried.
   */
  INIT_COMPLETED: 'init_completed',
  /**
   * Reticle found a defect in the app under test.
   *
   * THE metric the product exists to produce. Everything else here measures whether Reticle is used;
   * this measures whether it WORKS — and it is the only number that can honestly be put in front of
   * an investor or published, because it counts outcomes for users rather than activity by them.
   *
   * Deliberately a discrete event rather than only a counter: each bug carries its KIND, and the
   * distribution is the interesting part. "We found 4,000 bugs" is a claim; "1,200 of them were
   * greens that lied — a passing assertion sitting on a failed write, which no screenshot and no
   * human watching the screen would have caught" is the argument.
   */
  BUG_FOUND: 'bug_found',
} as const;
export type TelemetryEventKind = (typeof TelemetryEventKind)[keyof typeof TelemetryEventKind];

/**
 * Events that belong to a DAEMON RUN, and therefore carry `sessionId`.
 *
 * `sessionId` is minted per process, which is right for a daemon (a daemon run IS the session) and
 * wrong for a one-shot CLI command, which invents one that joins to nothing. Measured over a real
 * day: uniq(sessionId) was 704, of which 561 came from `cli_command_run` and NOT ONE was shared with
 * a daemon. The real number of daemon runs was 121, so every tile counting sessions was ~6x high.
 *
 * Omitting the id on the one-shot events costs nothing — no join on those ids could ever have
 * succeeded — and makes `uniq(sessionId)` mean the thing every dashboard already assumes it means.
 */
const SESSION_SCOPED: ReadonlySet<string> = new Set([
  TelemetryEventKind.DAEMON_STARTED,
  TelemetryEventKind.DAEMON_STOPPED,
  TelemetryEventKind.SESSION_PROGRESS,
  TelemetryEventKind.MCP_CLIENT_CONNECTED,
  TelemetryEventKind.PROJECT_PROFILED,
  TelemetryEventKind.VERIFICATION_COMPLETED,
  TelemetryEventKind.BUG_FOUND,
  TelemetryEventKind.RUNTIME_CRASHED,
  TelemetryEventKind.FEEDBACK_SUBMITTED,
]);

/** True when this event happened inside a daemon run, so a `sessionId` on it means something. */
export function isSessionScoped(kind: string): boolean {
  return SESSION_SCOPED.has(kind);
}

/**
 * Who caused this. The only honest split available to us: a `reticle` command was TYPED by a person,
 * while an MCP tool call came from the agent's own loop.
 *
 * What we deliberately do NOT claim to know is whether the human told the agent to verify or the
 * agent decided on its own — that lives in a prompt Reticle never sees. Inferring it from timing
 * would be a guess dressed as a measurement, and a dashboard cannot tell the difference later.
 */
export const TelemetryActor = {
  HUMAN: 'human',
  AGENT: 'agent',
} as const;
export type TelemetryActor = (typeof TelemetryActor)[keyof typeof TelemetryActor];

/**
 * What `projectId` was derived from — and therefore whether it is comparable ACROSS machines.
 *
 * This is the field that keeps "how many users share this project" from silently lying. A
 * cwd-derived id is unique per machine, so those rows always show exactly one user per project. Left
 * unlabelled they would drag the average toward 1 and hide real team adoption; labelled, the
 * analytics can restrict that question to `git_origin` rows, where it is a real measurement.
 */
export const ProjectIdSource = {
  /** Hash of the shared git origin — the same on every clone, so cross-machine counting is valid. */
  GIT_ORIGIN: 'git_origin',
  /** Hash of the local directory path — unique per machine; NOT comparable across users. */
  CWD: 'cwd',
} as const;
export type ProjectIdSource = (typeof ProjectIdSource)[keyof typeof ProjectIdSource];

/**
 * How Reticle reached the browser during a session. Distinguishes the always-on SDK (observing the
 * human's own tab) from a Reticle-launched or CDP-attached browser, which is the expensive path and
 * the one whose failures hurt most.
 */
export const BrowserLaunchKind = {
  /** `reticle drive` / `reticle verify` launched a browser. */
  LAUNCHED: 'launched',
  /** Attached to an already-running browser over `RETICLE_CDP_URL`. */
  ATTACHED: 'attached',
  /** A pooled headless context leased for a parallel flow. */
  POOLED: 'pooled',
} as const;
export type BrowserLaunchKind = (typeof BrowserLaunchKind)[keyof typeof BrowserLaunchKind];

/** The outcome of one verification. `verified` is Reticle's own honesty grade, not merely pass/fail. */
export const VerificationSchema = z.object({
  /** Which tool produced the verdict (`reticle_assert`, `reticle_flow_verify`, …). */
  via: z.string().min(1).max(64),
  /** `yes` | `no` | `unknown` — the honest verdict, where `unknown` means the evidence could not decide. */
  verified: z.string().min(1).max(16),
  /** Did the underlying assertion pass? Distinct from `verified` on purpose. */
  passed: z.boolean(),
  /**
   * TRUE when the assertion passed but Reticle refused to call it verified — a caught false green.
   * This is the product's whole thesis expressed as one boolean, and the number to put in a deck.
   */
  falseGreenCaught: z.boolean(),
  durationMs: z.number().int().nonnegative().optional(),
  /**
   * `headless` | `headed` | `attached` — how the browser under verification got there.
   *
   * Without it, "verifications run" is one undifferentiated number covering three different
   * products: unattended CI, a human watching an agent work, and the SDK in somebody's own dev
   * server. They have different costs, different failure modes and different value, and only the
   * last one is what most installs actually do.
   */
  browser: z.string().min(1).max(16).optional(),
  /**
   * WHICH browser it was — `chrome` | `edge` | `arc` | `dia` | `brave` | `opera` | `firefox` |
   * `safari` | `other`, from `BrowserBrand`.
   *
   * `browser` above says who drove it, and its most common value by far is `attached`: the SDK
   * connected from a browser Reticle never launched. That leaves the actual browser unknown, and
   * the engine cannot fill the gap — Chrome, Edge, Arc, Dia and Brave are one `blink`.
   *
   * OPTIONAL and absent rather than `"unknown"` when the page did not say: a desktop webview has no
   * brand, and an older SDK does not report one. A guessed value would be indistinguishable from a
   * measured one on a dashboard.
   */
  brand: z.nativeEnum(BrowserBrand).optional(),
  /**
   * WHICH clause of the honesty rule decided this — see `VerifiedReason`.
   *
   * `verified` alone cannot answer the question the product is judged on. `unknown` + `passed:false`
   * was measured covering "Reticle caught a real bug", "the agent wrote a bad predicate" and
   * "Reticle itself could not see", which need opposite responses and arrive as one value; `no`
   * collapses "channels disagree" into "the agent's predicate failed" the same way.
   *
   * OPTIONAL because not every verdict comes from `decideVerified` — a suite reports pass/fail with
   * no clause behind it, and an older SDK reports none. Absent means unclassified, never guessed.
   */
  reason: z.nativeEnum(VerifiedReason).optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

/** Which way the installed version moved, and between which versions. */
export const VersionChangeSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  /**
   * True when an agent had been told about exactly this version recently — so the nudge plausibly
   * caused the update.
   *
   * Without it, `version_changed` says a version moved and never why, which leaves "the nudge never
   * fired" and "the nudge fired and nobody acted" indistinguishable. Those need opposite responses,
   * and the whole adoption story rests on knowing which one is happening.
   */
  nudged: z.boolean().optional(),
  /** `update` (forward) or `rollback` (back) — a rollback is a release-quality alarm. */
  direction: z.string().min(1).max(16),
});
export type VersionChange = z.infer<typeof VersionChangeSchema>;

/**
 * A crash, with enough detail to actually diagnose it.
 *
 * The first version of this carried only a fingerprint — a hash — which made crashes RANKABLE and
 * completely UNDIAGNOSABLE: you could see that forty machines hit `a3f2c1d8e9b0` and had no way on
 * earth to learn what `a3f2c1d8e9b0` was. A group key with no dictionary. Everything below exists to
 * give the hash a meaning, while keeping the line that matters: our code and our failure, never the
 * user's code and never their data.
 */
/**
 * Whether a failed connection was aimed at a port Reticle itself uses.
 *
 * An enum rather than the number, because the number is the reporter's and the answer is ours: all
 * anyone needs to know is whose problem it is. Refused on a Reticle port is a lifecycle problem —
 * a daemon that is not up; refused anywhere else is somebody else's service.
 */
export const CrashPort = {
  RETICLE: 'reticle',
  OTHER: 'other',
} as const;
export type CrashPort = (typeof CrashPort)[keyof typeof CrashPort];

export const CrashSchema = z.object({
  /** `uncaught_exception` | `unhandled_rejection`. */
  kind: z.string().min(1).max(32),
  /** The error's constructor name (`TypeError`) — coarse, safe, and enough to triage. */
  errorType: z.string().min(1).max(64).optional(),
  /** Hash of the type + our own frames. Groups the same crash across every machine. */
  fingerprint: z.string().min(1).max(64).optional(),
  /**
   * The message with every VARIABLE part removed — quoted strings, URLs, paths, ids, numbers all
   * replaced by `*`. `no baseline named *` tells us exactly what broke; the flow name that made it
   * specific to one user never leaves. This is what turns the fingerprint from an opaque key into a
   * readable defect.
   */
  message: z.string().max(300).optional(),
  /**
   * The RETICLE-OWNED stack frames, innermost first, as `function@file:line`.
   *
   * This is our own published code — `runTool@invoke-tool.js:88` is a line anyone can read in the
   * npm tarball — so there is no privacy question in sending it, and it is the single most useful
   * thing for a root-cause analysis: the file, the line, and the function. Frames belonging to the
   * user's application or to node internals are dropped entirely before this is built.
   */
  frames: z.array(z.string().max(120)).max(12).optional(),
  /** The MCP tool in flight when it happened, when there was one. The trigger point. */
  tool: z.string().min(1).max(64).optional(),
  /**
   * The tool calls immediately before the failure, oldest first — the agent's approach run.
   *
   * Answers "what was it trying to do", which a single frame cannot: `snapshot → act → act →
   * assert` is a verification loop, `lease_acquire → navigate → crash` is a startup problem. Tool
   * NAMES only, from our own fixed vocabulary; no arguments, so nothing the agent typed is in here.
   */
  breadcrumb: z.array(z.string().max(64)).max(12).optional(),
  /** Node major/minor — crashes cluster hard by runtime version and we were not recording it. */
  nodeVersion: z.string().max(24).optional(),
  /** `arm64` / `x64`. A surprising number of native-module failures are architecture-specific. */
  arch: z.string().max(16).optional(),
  /**
   * The machine at the moment of the crash. "Out of memory" and "our bug" look identical in a stack
   * trace and are completely different problems; this is what tells them apart.
   */
  machine: MachineSnapshotSchema.optional(),
  /**
   * The failing SYSCALL — `connect`, `write`, `open`. Already inside `message`; structured here so
   * it can be grouped on rather than parsed back out of prose.
   */
  syscall: z.string().max(32).optional(),
  /**
   * The symbolic errno — `ECONNREFUSED`, `EPIPE`. The name, never the platform-specific number.
   */
  errno: z.string().max(32).optional(),
  /**
   * Was the target the machine it was running on?
   *
   * One bit, and it splits two populations that currently look identical and have different owners:
   * refused ON loopback is a Reticle-lifecycle problem (no daemon), refused off-box is a network
   * problem that is not ours.
   */
  loopback: z.boolean().optional(),
  /** Whether the port was one of ours, as an enum. The number itself is never sent. */
  port: z.enum([CrashPort.RETICLE, CrashPort.OTHER]).optional(),
  /**
   * The innermost frame naming NODE's own source — `node:net:1637`.
   *
   * Only present when the crash is a system error AND no Reticle frame survived, which is exactly
   * the report that otherwise arrives with no location at all. It is a line in Node's published
   * source: it says a connect failed rather than a DNS lookup, and carries nothing about the
   * machine, the app, or anyone's directory layout.
   */
  internalFrame: z.string().max(64).optional(),
});
export type Crash = z.infer<typeof CrashSchema>;

/**
 * How Reticle came to find a defect. Four routes, in descending order of "a human would have missed
 * this": a contradiction is invisible to someone watching the screen, a crawl finding required no
 * script at all, a replay failure is a regression on something that used to work, and a failed
 * assertion is the agent's own check not holding.
 */
export const BugSource = {
  /** Channels disagreed — the false green. A passing screen sitting on a failed write. */
  CONTRADICTION: 'contradiction',
  /** `reticle_crawl` found it autonomously, with nobody writing a test. */
  CRAWL: 'crawl',
  /** A saved flow that used to pass stopped passing — a regression. */
  REPLAY: 'replay',
  /** An assertion the agent declared did not hold. */
  ASSERTION: 'assertion',
} as const;
export type BugSource = (typeof BugSource)[keyof typeof BugSource];

/**
 * WHOSE fault the defect was.
 *
 * `bugsFound` is the number this product would most like to publish, and it is not publishable
 * without this. Measured over one real session: 8 `bug_found` events, of which **one** was a defect
 * in the app under test. The other seven were the agent's own bad predicates (a store path that
 * never existed, an impossible selector) and one empty ref, all published as defects in the
 * customer's product. A founder steering on that number is steering on noise.
 *
 * Deliberately OMITTED rather than guessed when the evidence does not say. A failed `element.present`
 * covers "the button is missing", "the API is down" and "the agent mistyped a testid" identically,
 * and inventing an owner for it would put a guess into the one number we intend to publish — the
 * same mistake `brand` refuses to make by being absent rather than `"unknown"`.
 */
export const BugAttribution = {
  /** A defect in the app under test — the only bucket that belongs in a published defect count. */
  APP: 'app',
  /** The agent's own call was wrong: a path, store or target that never existed. Teach the agent. */
  REQUEST: 'request',
  /** Reticle could not see or could not drive. Our bug, or our configuration. Ship a fix. */
  RETICLE: 'reticle',
} as const;
export type BugAttribution = (typeof BugAttribution)[keyof typeof BugAttribution];

/**
 * One defect Reticle found in the app under test.
 *
 * `kind` is the taxonomy value from `findings.ts` — `signal-contradicted`, `console-error`,
 * `duplicate-request` and so on. Never a selector, a URL, an element, or any description of the
 * user's app: we report THAT a class of defect was found, never WHAT it was in.
 */
export const BugFoundSchema = z.object({
  source: z.nativeEnum(BugSource),
  /** The classified kind from Reticle's own findings vocabulary. */
  kind: z.string().min(1).max(64),
  /**
   * True when the defect PRESENTED AS SUCCESS — the screen advanced, the assertion passed, the click
   * looked fine — while another channel showed it had not.
   *
   * Defined by the presentation rather than by "an assertion passed", because the same defect arrives
   * both ways: through `reticle_assert` there IS a passing assertion to contradict, and through
   * `reticle_crawl` there is no assertion at all and the UI simply moved on over a failed write. Both
   * are the thing a human watching the screen cannot see, and that is what the flag has to mean if
   * the number is going to be published.
   *
   * The subset worth naming separately, because it is the only category Reticle can claim as uniquely
   * its own: every other kind of bug is findable by a careful human or an ordinary test.
   */
  falseGreen: z.boolean(),
  /** Which tool surfaced it. */
  tool: z.string().min(1).max(64).optional(),
  /**
   * TRUE when this KIND was already reported in this session — i.e. this is another INSTANCE of a
   * defect already counted, not another defect.
   *
   * Both numbers are claims, and they are different ones. "Reticle found N defects" is the headline;
   * "users hit them M times" is the frequency that says which ones actually cost anybody anything.
   * Without this flag the event stream answers only the second while looking like it answers the
   * first, so any distinct-defect count read off it is silently inflated — the exact way a published
   * number goes wrong. Count `repeat: false` for distinct, count everything for instances.
   *
   * Scoped to the SESSION, because that is the only identity available: the payload deliberately
   * carries no selector, URL or app detail, so the same defect in two sessions cannot be recognised
   * as one — and must not be, since that would need data this event refuses to collect.
   */
  repeat: z.boolean(),
  /**
   * Whose fault it was — `app` | `request` | `reticle`. ABSENT when the evidence cannot say; see
   * `BugAttribution`. Count `attribution: 'app'` for defects found in anybody's product.
   */
  attribution: z.nativeEnum(BugAttribution).optional(),
});
export type BugFound = z.infer<typeof BugFoundSchema>;

/** An MCP client attaching. Separates "installed and running" from "someone is actually using it". */
export const McpConnectionSchema = z.object({
  /** False the first time a client attaches to this daemon; true for every attach after. */
  reconnect: z.boolean(),
  /**
   * How long the daemon had been up first. A large value on the FIRST connect is the interesting
   * case — it means Reticle was started and then sat unused, which is an onboarding failure nobody
   * would otherwise report.
   */
  daemonAgeMs: z.number().int().nonnegative(),
  /** Which client, from its own handshake (`claude-code`, `cursor`). */
  client: z.string().min(1).max(64).optional(),
});
export type McpConnection = z.infer<typeof McpConnectionSchema>;

/**
 * WHICH stage of an MCP outage this is. Reported at most twice per proxy process, and the two are
 * different facts: `first` says the session lost its tools at all, `budget_spent` says the proxy
 * stopped retrying and never came back on its own.
 */
export const OutageStage = {
  FIRST: 'first',
  BUDGET_SPENT: 'budget_spent',
} as const;
export type OutageStage = (typeof OutageStage)[keyof typeof OutageStage];

/**
 * WHY the stream went away, as far as the proxy can tell. A closed vocabulary because the proxy's
 * own reason strings are free text feeding a log — `OTHER` is the bucket that lets a new one arrive
 * without a raw string reaching the wire, per the classifier rule.
 */
export const OutageReason = {
  /** The SSE stream ended cleanly — usually the daemon exiting. */
  SSE_ENDED: 'sse_ended',
  /** The stream errored. */
  SSE_ERROR: 'sse_error',
  /** The socket died under us with neither `end` nor `error` — daemon killed, network reset. */
  SSE_ABORTED: 'sse_aborted',
  /** The response closed. */
  SSE_CLOSED: 'sse_closed',
  /** A reconnect attempt could not reach the daemon at all. */
  CONNECT_ERROR: 'connect_error',
  /** Anything the proxy reported that this list does not name. A classifier must be able to say so. */
  OTHER: 'other',
} as const;
export type OutageReason = (typeof OutageReason)[keyof typeof OutageReason];

/**
 * The agent LOST its Reticle tools.
 *
 * This block existed on the emitter's input type and never on the wire: `emit()` builds its event
 * from an explicit allow-list of keys and `outage` was not in it, so two deliberately different
 * outages — `first`/`sse_ended`/3 and `budget_spent`/`connect_error`/12 — produced byte-identical
 * events. Against a standing "MCP must never go down" mandate, the metric that measures it reported
 * a bare count with no cause and no recovery signal. This is the schema half of the fix.
 */
export const McpOutageSchema = z.object({
  stage: z.nativeEnum(OutageStage),
  reason: z.nativeEnum(OutageReason),
  /** Consecutive reconnects tried when this was reported. `first` is near 1; a spent budget is high. */
  attempts: z.number().int().nonnegative(),
});
export type McpOutage = z.infer<typeof McpOutageSchema>;

/** How `reticle init` went. The onboarding funnel, which had no instrumentation whatsoever. */
export const InitOutcomeSchema = z.object({
  ok: z.boolean(),
  /** Classified cause when it failed — our vocabulary, never a raw error or a path. */
  reason: z.string().max(64).optional(),
  /** The framework it detected, so we can see which stacks fail to set up. */
  stack: z.string().max(64).optional(),
  /** Whether the MCP registration step succeeded — the step most likely to fail silently. */
  mcpRegistered: z.boolean().optional(),
});
export type InitOutcome = z.infer<typeof InitOutcomeSchema>;

/**
 * One anonymous telemetry event. `anonymousId` and the optional hashed `projectId` are the only
 * identifiers; everything else is a low-cardinality dimension for slicing the adoption metrics.
 */
export const TelemetryEventSchema = z.object({
  v: z.literal(TELEMETRY_EVENT_VERSION),
  /** Random UUID persisted at `~/.reticle/telemetry-id`. Distinct-count of this = users (DAU/WAU/MAU). */
  anonymousId: z.string().min(1).max(128),
  /** One-way hash of the git remote (or cwd) — counts DISTINCT PROJECTS without revealing any of them. */
  projectId: z.string().min(1).max(128).optional(),
  /**
   * One daemon run. Ties `daemon_started` → every verification → a crash → `daemon_stopped` into a
   * single story.
   *
   * Without it, events could only be grouped by machine and approximate time — so "what was happening
   * when this crashed?" was unanswerable, three concurrent daemons on one machine (which the product
   * explicitly supports) interleaved into one undifferentiated stream, and no per-session funnel could
   * be built at all. It cannot be backfilled, which is why it is worth adding before the data matters.
   */
  /**
   * The daemon run this happened inside. ABSENT on one-shot CLI events — see isSessionScoped: a
   * per-process id on `reticle status` is not a session, it is a number that inflates every session
   * count and joins to nothing.
   */
  sessionId: z.string().min(1).max(64).optional(),
  event: z.nativeEnum(TelemetryEventKind),
  /** Client epoch-ms when the event happened (the server also stamps its own receive time). */
  ts: z.number().int().nonnegative(),
  /** Reticle version emitting the event — lets us see adoption of new releases + version spread. */
  version: z.string().min(1).max(64),
  /** Runs inside CI? Separates real human DAU from pipeline traffic (both matter, differently). */
  ci: z.boolean(),
  /**
   * What `projectId` was derived from. On EVERY event, not just the profile, because the core
   * counting questions ("users per project", "projects per user") run over all events and need to
   * know which rows are comparable across machines without joining to another event first.
   */
  projectIdSource: z.nativeEnum(ProjectIdSource).optional(),
  /** `process.platform` (darwin/linux/win32) — OS mix, low cardinality, non-identifying. */
  os: z.string().min(1).max(32),
  /**
   * Minutes this machine's local time is offset from UTC.
   *
   * "When do they work" was answerable only through ingest-side GeoIP, which may be off and is a
   * coarser thing than a working day. One integer, no location, identifies nobody — and it turns
   * every time-of-day tile from "which continent" into "9am or 11pm".
   */
  tzOffsetMin: z.number().int().min(-900).max(900).optional(),
  /** Only on `feedback`: the author-submitted report + its environment context. Never sent otherwise. */
  feedback: FeedbackSchema.optional(),
  /** Human or agent. Absent on events that are neither (a crash, a version change). */
  actor: z.nativeEnum(TelemetryActor).optional(),
  /** Only on `cli_command_run`: which subcommand. */
  command: z.string().min(1).max(32).optional(),
  /**
   * Only on `cli_command_run`: which flags were PRESENT, by name. Never their values — a flag value
   * is a port, a URL, a file path, or in `--http-token`'s case a secret. Names alone answer the
   * question ("does anyone use `--storage-state`?") with none of that risk.
   */
  flags: z.array(z.string().max(32)).max(16).optional(),
  /** Only on `daemon_stopped`: the whole session rolled into one event. */
  session: SessionSummarySchema.optional(),
  /** Only on `project_profiled`: the shape and depth-of-use of the project. */
  project: ProjectProfileSchema.optional(),
  /** Only on `verification_completed`. */
  verification: VerificationSchema.optional(),
  /** Only on `version_changed`. */
  versionChange: VersionChangeSchema.optional(),
  /** Only on `runtime_crashed`. */
  crash: CrashSchema.optional(),
  /** Only on `identified` — self-declared, opt-in, and the only personal data ever sent. */
  identity: IdentitySchema.optional(),
  /** Only on `mcp_client_connected`. */
  connection: McpConnectionSchema.optional(),
  /** Only on `init_completed`. */
  init: InitOutcomeSchema.optional(),
  /** Only on `bug_found`. */
  bug: BugFoundSchema.optional(),
  /** Only on `mcp_connection_lost`: which stage of the outage, why, and after how many retries. */
  outage: McpOutageSchema.optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
