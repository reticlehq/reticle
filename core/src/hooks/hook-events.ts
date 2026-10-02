/**
 * What Reticle says happened, and the shape it says it in.
 *
 * This is a CONTRACT, not an internal enum, which is why it lives in `core` beside the wire types.
 * A hook payload crosses into somebody else's script, so renaming an event kind is a breaking
 * change and has to be treated as one.
 *
 * Every event is a MOMENT SOMETHING BECAME TRUE, never a step on the way there. `verdict` is a
 * verdict; there is no `verdict_starting`, no `snapshot_taken`, no per-tool-call firehose — an event
 * that fires on internal progress freezes internal structure into a public contract. The bar for
 * adding one is the bar for a tool: name what a consumer could not otherwise know, and that stays
 * true if the implementation is rewritten.
 *
 * A payload carries NO credentials, ever — not the pairing token, not the cloud API key, not a
 * session cookie the page was carrying. Assume anything put here ends up in a log nobody here
 * controls. `hook-payload-carries-no-secret.test.ts` is the check, and it reads this file's schemas
 * rather than a hand-kept list.
 */

import { z } from 'zod';

/**
 * The events a hook can attach to.
 *
 * Values are the STRING a user writes in `.reticle/hooks.json`, so they read as English and stay
 * stable. A constant object rather than a TypeScript `enum` for the same reason as everything else
 * here: it survives `JSON.stringify` and a consumer can compare against the literal.
 */
export const HookEvent = {
  /**
   * A verdict landed — the thing this product exists to produce.
   *
   * Fires for ALL FOUR outcomes, `unknown` and `no-fault` included. A hook that only heard about
   * passes and failures would be told a different story from the one the verdict channel tells, and
   * "I could not tell" leaving the account is precisely the failure mode Reticle is built to stop.
   */
  VERDICT: 'verdict',
  /**
   * A defect was found. One event per defect, not one per run.
   *
   * Carries `repeat`, so a consumer can tell a newly-found defect from the same one seen again
   * without keeping its own ledger — counting instances as defects is how a number inflates itself.
   */
  BUG_FOUND: 'bug_found',
  /** A browser session attached. */
  SESSION_STARTED: 'session_started',
  /** A browser session ended, and its run artifact (if any) is on disk by the time this fires. */
  SESSION_ENDED: 'session_ended',
  /**
   * A cloud sync cycle finished, with what it actually moved.
   *
   * Fires on a cycle that sent NOTHING too. "Nothing changed" and "sync is broken" look identical
   * from outside, and a consumer that cannot tell them apart has to guess.
   */
  SYNC_COMPLETED: 'sync_completed',
} as const;

export type HookEventName = (typeof HookEvent)[keyof typeof HookEvent];

/** Every event name, for validating a config file and for telling a user what they may write. */
export const HOOK_EVENT_NAMES: readonly HookEventName[] = Object.values(HookEvent);

/**
 * Carried on every payload, so a consumer reading one event off stdin knows what it is holding
 * without being told out of band.
 *
 * `at` is an ISO timestamp rather than an epoch number because the first thing most hook scripts do
 * is print it, and because a payload is a document a human may end up reading in a log.
 */
const BaseHookPayload = z.object({
  event: z.enum(HOOK_EVENT_NAMES as [HookEventName, ...HookEventName[]]),
  at: z.string(),
  /** The project this happened in, when one is identifiable. Absent outside a wired project. */
  projectId: z.string().optional(),
});

export const VerdictHookPayloadSchema = BaseHookPayload.extend({
  event: z.literal(HookEvent.VERDICT),
  /** The tool that produced it — `reticle_assert`, `reticle_act_and_wait`, and so on. */
  tool: z.string(),
  /** `yes` | `no` | `unknown` | `no-fault`, in the protocol's own words. */
  verified: z.string(),
  /** The sentence the verdict gave for itself, when it gave one. */
  because: z.string().optional(),
  sessionId: z.string().optional(),
  url: z.string().optional(),
});
export type VerdictHookPayload = z.infer<typeof VerdictHookPayloadSchema>;

export const BugFoundHookPayloadSchema = BaseHookPayload.extend({
  event: z.literal(HookEvent.BUG_FOUND),
  /** The finding kind from core's enum — `response-ignored`, `state-vs-render`, and so on. */
  kind: z.string(),
  /** Which channel reported it. */
  source: z.string().optional(),
  /** Stable across runs for the same defect, so a consumer can deduplicate without heuristics. */
  fingerprint: z.string().optional(),
  /** True when this defect kind has already been seen in this session. */
  repeat: z.boolean(),
  /** The route it was found on, when the result named one. */
  route: z.string().optional(),
  tool: z.string(),
  sessionId: z.string().optional(),
});
export type BugFoundHookPayload = z.infer<typeof BugFoundHookPayloadSchema>;

export const SessionHookPayloadSchema = BaseHookPayload.extend({
  event: z.enum([HookEvent.SESSION_STARTED, HookEvent.SESSION_ENDED]),
  sessionId: z.string(),
  url: z.string().optional(),
  /** `web`, `electron`, `tauri` — absent on an SDK too old to report one, never defaulted. */
  runtime: z.string().optional(),
});
export type SessionHookPayload = z.infer<typeof SessionHookPayloadSchema>;

export const SyncHookPayloadSchema = BaseHookPayload.extend({
  event: z.literal(HookEvent.SYNC_COMPLETED),
  /** How many run artifacts this cycle pushed. Zero is a real and useful answer. */
  runsPushed: z.number().int().nonnegative(),
  /** Whether the cycle completed without error. */
  ok: z.boolean(),
  /** Why it failed, when it did. */
  error: z.string().optional(),
});
export type SyncHookPayload = z.infer<typeof SyncHookPayloadSchema>;

/** Any hook payload. A consumer narrows on `event`, which every variant carries as a literal. */
export const HookPayloadSchema = z.discriminatedUnion('event', [
  VerdictHookPayloadSchema,
  BugFoundHookPayloadSchema,
  SessionHookPayloadSchema.extend({ event: z.literal(HookEvent.SESSION_STARTED) }),
  SessionHookPayloadSchema.extend({ event: z.literal(HookEvent.SESSION_ENDED) }),
  SyncHookPayloadSchema,
]);
export type HookPayload = z.infer<typeof HookPayloadSchema>;

/**
 * The file a user writes: event name to command.
 *
 * A single command per event, deliberately. A list would invite "run these five things in order",
 * which is a build system, and the shell already has one — a user who needs two things writes a
 * script that does two things, and keeps the failure handling where they can see it.
 */
export const HookConfigSchema = z.record(z.string(), z.string());
export type HookConfig = z.infer<typeof HookConfigSchema>;
