/**
 * Refusals — why a tool could not do what was asked, and the row that reports one.
 *
 * `telemetry.ts` next door is the session wire; this is the refusal vocabulary that
 * `error-recovery.ts` is graded against. `NoSessionReason` has its own module because it refines
 * exactly one member of the enum below.
 */

import * as z from 'zod';
import { NoSessionReason } from './words/no-session-reason.js';

/**
 * WHY a tool could not do what was asked.
 *
 * Derived from the refusal paths that actually exist rather than invented: every member below is a
 * bucket over `error-recovery.ts`'s recovery table, which is the single place a thrown message is
 * turned into a next action. That table is the vocabulary; this is its coarse grouping, and a new
 * entry there cannot compile without being classified here.
 *
 * The five that matter belong to four different owners, which is the whole reason for splitting
 * them: `no_session` is the install's second half never happening, `bad_args` is the agent's own
 * call, `not_ready` is the environment, and `no_match` / `unsupported` are the app and Reticle's
 * own capability surface. One undifferentiated "the agent stopped" number cannot be acted on by anyone.
 */
export const RefusalReason = {
  /** There was no app to reach: nothing connected, no session by that id, or several with none named. */
  NO_SESSION: 'no_session',
  /** The target did not exist: a stale ref, a missing baseline, an option value the select has not got. */
  NO_MATCH: 'no_match',
  /** Reticle refuses to pretend: a rich-text surface, a disabled field, a destructive control. */
  UNSUPPORTED: 'unsupported',
  /** The call did not match the schema, or named a value our own validators reject. */
  BAD_ARGS: 'bad_args',
  /** Nothing is wrong with the call; the world is not ready — a throttled tab, a timeout, no browser. */
  NOT_READY: 'not_ready',
  /** A refusal this list does not name. A classifier that cannot say "I don't know" lies instead. */
  OTHER: 'other',
} as const;
export type RefusalReason = (typeof RefusalReason)[keyof typeof RefusalReason];

/**
 * WHICH cause inside a `RefusalReason` bucket, when the server can tell.
 *
 * One member for each entry of `error-recovery.ts`'s recovery table. A missing browser pool has
 * three: no pool, a pool that is shut down, and no Chromium for Playwright. They need different
 * fixes, and `not_ready` alone could not say which one stopped a user. Never the message.
 */
export const RefusalDetail = {
  NO_SESSION: 'no_session',
  MULTIPLE_SESSIONS: 'multiple_sessions',
  UNKNOWN_SESSION: 'unknown_session',
  SCOPE_MISMATCH: 'scope_mismatch',
  SESSION_GONE: 'session_gone',
  THROTTLED: 'throttled',
  COMMAND_TIMEOUT: 'command_timeout',
  /** The daemon has no browser pool: Reticle did not start through `reticle mcp`. */
  POOL_UNAVAILABLE: 'pool_unavailable',
  /** The browser pool stopped, because the daemon is shutting down. */
  POOL_SHUT_DOWN: 'pool_shut_down',
  /** Playwright has no Chromium installed. */
  CHROMIUM_MISSING: 'chromium_missing',
  /** RETICLE_CHROMIUM_PATH names a browser the daemon cannot launch. */
  CHROMIUM_PATH: 'chromium_path',
  TOKEN_REQUIRED: 'token_required',
  MISSING_BASELINE: 'missing_baseline',
  MISSING_RECORDING: 'missing_recording',
  STALE_REF: 'stale_ref',
  STALE_REF_AFTER_EDIT: 'stale_ref_after_edit',
  UNISSUED_REF: 'unissued_ref',
  NO_SUCH_OPTION: 'no_such_option',
  TARGET_MISSED: 'target_missed',
  AMBIGUOUS_TARGET: 'ambiguous_target',
  FLOW_STEP_MISSING: 'flow_step_missing',
  UNSUPPORTED_SURFACE: 'unsupported_surface',
  HOVER_NEEDS_POINTER: 'hover_needs_pointer',
  NOT_EDITABLE: 'not_editable',
  CONFIRM_DANGEROUS: 'confirm_dangerous',
  WRONG_TARGET: 'wrong_target',
  PRODUCTION_POLICY: 'production_policy',
  BAD_ARGUMENTS: 'bad_arguments',
  INVALID_NAME: 'invalid_name',
  HARNESS_OFF: 'harness_off',
  HARNESS_LOCKED: 'harness_locked',
} as const;
export type RefusalDetail = (typeof RefusalDetail)[keyof typeof RefusalDetail];

/** One tool call that could not be served. */
export const ToolRefusalSchema = z.object({
  /** Which tool. A name from our own fixed namespace, never app data. */
  tool: z.string().min(1).max(64),
  reason: z.nativeEnum(RefusalReason),
  /**
   * For `no_session` only: WHICH no-session situation, from core's closed `NoSessionReason`.
   *
   * Rides the refusal rather than the profile because this is where the diagnosis is actually
   * COMPUTED - `project_profiled` fires once at daemon start, before any tool call has failed, so
   * it cannot carry a reason that does not exist yet. Absent on every other refusal reason.
   */
  noSessionReason: z.nativeEnum(NoSessionReason).optional(),
  /**
   * WHICH cause inside `reason`, from core's closed `RefusalDetail`. Absent when the recovery table
   * did not recognise the message, and on a refusal that diagnosed itself.
   */
  detail: z.nativeEnum(RefusalDetail).optional(),
  /**
   * TRUE when the call immediately before this one was the SAME tool, also refused.
   *
   * Reported on the RETRY rather than on the first refusal, because the first refusal has to be sent
   * at the moment it happens: deferring it until the next call is known would lose it entirely for
   * the agent that gives up, and that agent is the whole population this event exists to describe.
   * So count `retried: true` for retries; the ratio against all refusals is whether the diagnosis
   * gets anybody unstuck.
   */
  retried: z.boolean(),
  /**
   * The arguments the refused call passed, by NAME, with the value only for an enum we defined
   * (`action:list`, else `action:other`), as `toolParams` reports them. Never a free value. A
   * `bad_args` refusal said nothing about the call's shape, so a tool that confuses agents could
   * not be told apart from one that agents never reach.
   */
  params: z.array(z.string().min(1).max(64)).max(16).optional(),
});
export type ToolRefusal = z.infer<typeof ToolRefusalSchema>;
