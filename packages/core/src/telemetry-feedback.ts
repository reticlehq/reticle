/**
 * The FEEDBACK and IDENTITY contract — the only two things Reticle ever sends that a person wrote.
 *
 * Split out of `telemetry.ts` because they are a different privacy class from everything else there.
 * The rest of telemetry is counters and enums that cannot describe anyone; these two carry authored
 * text and a self-declared identity, they are never emitted passively, and they each have their own
 * consent story. Keeping them in one file makes that boundary something you can see rather than
 * something you have to remember — and it keeps the event contract under the size cap.
 *
 * Neither is ever populated by inference. A `Feedback` exists because an agent called
 * `reticle_feedback` or a human ran `reticle feedback`; an `Identity` exists because a human ran
 * `reticle identify`. There is no code path to either that a person did not start.
 */
import { z } from 'zod';

/** Who authored the feedback. Agents report failures; humans also rate the experience. */
export const FeedbackSource = {
  AGENT: 'agent',
  HUMAN: 'human',
} as const;
export type FeedbackSource = (typeof FeedbackSource)[keyof typeof FeedbackSource];

/**
 * What kind of report this is. The first three are the agent's vocabulary — they name the three ways
 * Reticle fails an agent, and keeping them distinct is the whole point: a BUG is our defect, a GAP is
 * a thing we cannot see at all, and an AMBIGUITY is a verdict the agent could not act on. Lumping
 * them into "it didn't work" would destroy the only signal that says what to build next.
 */
export const FeedbackKind = {
  /** A tool misbehaved: wrong result, crash, or a contract it did not honor. */
  BUG: 'bug',
  /** Reticle could not observe something the agent needed — a blind spot, not a defect. */
  GAP: 'gap',
  /** The verification ran but its verdict was not decidable — pass/fail could not be told apart. */
  AMBIGUITY: 'ambiguity',
  /**
   * "I wish Reticle could do X." Something that does not exist and would have helped.
   *
   * Reticle is built FOR agents, so the agent is the user whose wishes matter most — and it is the
   * one user who never gets asked. It hits a limitation, works around it, finishes the task, and the
   * wish evaporates with the context window. This is the channel for it, and it is deliberately as
   * easy to file as a bug: the friction that stops people reporting failures stops them twice as
   * hard for something that is merely a nice-to-have.
   */
  FEATURE_REQUEST: 'feature_request',
  /**
   * Something that EXISTS but is awkward — too many calls, a confusing shape, a slow path.
   *
   * Kept separate from a feature request because the responses differ completely: one is "build the
   * missing thing", the other is "the thing is there and the ergonomics are wrong". Collapsing them
   * would hide the second inside the first, and the second is usually cheaper and higher-impact.
   */
  IMPROVEMENT: 'improvement',
  /**
   * "This worked, and here is what it did." An overall take on using Reticle, carrying `rating`.
   *
   * Filed by a human at a terminal OR by an agent mid-task, and the agent case is the one that was
   * missing: every other kind an agent can file is a complaint, so the corpus could only ever grow
   * into a defect list. Nothing in it said which parts were worth protecting when we changed them,
   * which is the question a refactor actually needs answered.
   *
   * A score alone is close to worthless here and the tool says so: a model asked for a number will
   * produce an agreeable one, and an agreeable number is indistinguishable from an earned one once
   * both are in the same column. What makes a report usable is the `text` naming the concrete
   * moment, which is also the only part that can be quoted or acted on.
   */
  EXPERIENCE: 'experience',
} as const;
export type FeedbackKind = (typeof FeedbackKind)[keyof typeof FeedbackKind];

/** Which shell the verified app runs in. Mirrors the SDK's own `PAGE_HEALTH` runtime report. */
export const AppRuntime = {
  WEB: 'web',
  ELECTRON: 'electron',
  TAURI: 'tauri',
} as const;
export type AppRuntime = (typeof AppRuntime)[keyof typeof AppRuntime];

/** The rendering engine behind the connected page — coarse on purpose (three values, not a UA string). */
export const BrowserEngine = {
  BLINK: 'blink',
  GECKO: 'gecko',
  WEBKIT: 'webkit',
} as const;
export type BrowserEngine = (typeof BrowserEngine)[keyof typeof BrowserEngine];

/**
 * The browser BRAND behind the connected page — the axis `engine` cannot answer.
 *
 * Chrome, Edge, Arc, Dia, Brave and Opera are all `blink`, and the most common mode by far is
 * `attached`: Reticle launched nothing, so the page itself is the only thing that knows which
 * browser it is. A CLOSED list on purpose — the raw UA string and a raw `userAgentData` brand are
 * both unbounded and fingerprintable, so anything unrecognised reports `OTHER` rather than
 * forwarding a name we have never seen.
 */
export const BrowserBrand = {
  CHROME: 'chrome',
  EDGE: 'edge',
  ARC: 'arc',
  DIA: 'dia',
  BRAVE: 'brave',
  OPERA: 'opera',
  FIREFOX: 'firefox',
  SAFARI: 'safari',
  /** Anything we do not recognise — including a Chromium that names no brand at all. */
  OTHER: 'other',
} as const;
export type BrowserBrand = (typeof BrowserBrand)[keyof typeof BrowserBrand];

/** How Reticle reaches the page: a driven CDP browser, or the SDK inside the human's own browser. */
export const PageDriver = {
  CDP: 'cdp',
  SDK: 'sdk',
} as const;
export type PageDriver = (typeof PageDriver)[keyof typeof PageDriver];

/** Where the MCP server is registered — a user-level install serves every project, a project-level one doesn't. */
export const McpScope = {
  USER: 'user',
  PROJECT: 'project',
} as const;
export type McpScope = (typeof McpScope)[keyof typeof McpScope];

export const FEEDBACK_TEXT_MAX = 4000;
export const FEEDBACK_TRACE_MAX = 8000;
export const FEEDBACK_RATING_MIN = 1;
export const FEEDBACK_RATING_MAX = 5;
/** Cap for the structured why/impact/workaround fields — prose, but bounded prose. */
export const FEEDBACK_FIELD_MAX = 1000;

/**
 * The feedback body. Everything here is either author-written (`text`, `trace`, `rating`) or
 * environment context detected locally (`stack`, `runtime`, `engine`, …) — the context is what turns
 * "a tool broke" into "a tool breaks on Tauri + SvelteKit", which is the difference between a
 * complaint and a work item.
 *
 * `text`/`trace` are the ONLY free-text fields Reticle ever sends. They are opt-in by action (nothing
 * is scraped — someone typed or wrote them), capped, and redacted client-side before the wire.
 */
export const FeedbackSchema = z.object({
  source: z.nativeEnum(FeedbackSource),
  kind: z.nativeEnum(FeedbackKind),
  /** The author's account. For an agent: what failed and why (its RCA). For a human: their words. */
  text: z.string().min(1).max(FEEDBACK_TEXT_MAX),
  /** Agent-side only: the call/response trail that led to the failure, so the RCA is reproducible. */
  trace: z.string().max(FEEDBACK_TRACE_MAX).optional(),
  /** Human-side only: 1–5. The single number that trends without reading a word. */
  rating: z.number().int().min(FEEDBACK_RATING_MIN).max(FEEDBACK_RATING_MAX).optional(),
  /**
   * WHY it is wanted — the goal behind the request, not the request itself.
   *
   * The most common way a feature request wastes everyone's time is arriving as a solution with the
   * problem stripped off. "Add a `waitForIdle` tool" is a guess about implementation; "I need to know
   * the page stopped changing before I assert" is a requirement, and it may already have an answer.
   */
  need: z.string().max(FEEDBACK_FIELD_MAX).optional(),
  /** What measurably gets better — fewer calls, fewer retries, a verdict that stops being ambiguous. */
  impact: z.string().max(FEEDBACK_FIELD_MAX).optional(),
  /**
   * How the author works around it TODAY. Usually the most valuable field in the whole report.
   *
   * A workaround is evidence rather than opinion: it shows what the agent actually did, proves the
   * need is real enough to have cost it something, and frequently reveals that the missing feature is
   * a worse fix than removing whatever forced the workaround.
   */
  currentApproach: z.string().max(FEEDBACK_FIELD_MAX).optional(),
  /**
   * The MODEL the agent is running, self-reported.
   *
   * Not obtainable any other way: MCP's `clientInfo` carries a client name and version and has no
   * concept of a model, so the transport cannot tell us. The agent knows, and this report is already
   * something the agent authored — so asking is both the only mechanism and a reliable one.
   *
   * It matters more than it looks: a limitation that blocks a smaller model may be a docs problem
   * rather than a missing feature, and a request from a frontier model is evidence the surface itself
   * is short. Without it, every request looks the same.
   */
  model: z.string().min(1).max(64).optional(),
  /** The MCP client's own version, alongside its name — so "cursor 0.42 specifically" is answerable. */
  clientVersion: z.string().min(1).max(32).optional(),
  /** The framework detected in the project (`next`, `vite`, `sveltekit`, `vue`, `astro`, …). */
  stack: z.string().min(1).max(64).optional(),
  /**
   * The MAJOR version of that framework ("15", "19"). Major only, deliberately: it is what actually
   * segments a bug ("breaks on React 19" is a work item; "breaks on 19.0.0-rc.1-canary" is noise),
   * and a full version string is high-cardinality enough to start narrowing down who sent it.
   */
  stackMajor: z.number().int().nonnegative().optional(),
  runtime: z.nativeEnum(AppRuntime).optional(),
  engine: z.nativeEnum(BrowserEngine).optional(),
  driver: z.nativeEnum(PageDriver).optional(),
  /** The MCP client on the other end (`claude-code`, `cursor`, …) — self-reported at initialize. */
  client: z.string().min(1).max(64).optional(),
  mcpScope: z.nativeEnum(McpScope).optional(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

/** What Reticle is being used for. Self-declared; never inferred. */
export const UsageContextKind = {
  COMPANY: 'company',
  SIDE_PROJECT: 'side_project',
  OPEN_SOURCE: 'open_source',
  LEARNING: 'learning',
} as const;
export type UsageContextKind = (typeof UsageContextKind)[keyof typeof UsageContextKind];

/**
 * A self-declared identity. The ONLY personal data Reticle ever transmits, and it transmits it only
 * because someone typed `reticle identify`. Every field is optional except the context, so a user can
 * say "this is a company" without saying which, or name the company without leaving an email.
 */
export const IdentitySchema = z.object({
  context: z.nativeEnum(UsageContextKind),
  company: z.string().min(1).max(128).optional(),
  email: z.string().min(3).max(254).optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;
