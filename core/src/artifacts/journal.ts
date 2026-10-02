import { z } from 'zod';
import { TRANSPORT_LIMITS, TruncationChannel } from '@/wire/constants/constants.js';
import { Verified } from '@/verdict/verified-constants.js';
import { PredicateKind } from '@/verdict/consequence.js';

/**
 * The durable causal journal. Each session gets an append-only pair on disk:
 * `.reticle/sessions/<id>/events.jsonl` (one `ReticleEvent` per line — already seq/actionId-stamped
 * and browser-edge-redacted) and `actions.jsonl` (one JournalAction per line). The ring buffer becomes
 * a hot cache over this ledger, so evidence survives eviction. Local-only; JSONL is versioned per line
 * so a schema bump never orphans an old file.
 */

/** Per-record schema version. JSONL is line-addressable, so versioning rides each record, not a header. */
export const JOURNAL_FILE_VERSION = 1;

/**
 * An action entity — every act/navigate the server dispatches. `seqRange`/`tRange` are the window used
 * to attribute events to this action (`attribution:"window"`); `effect` is a bounded summary of what
 * the tool returned. Args are already edge-redacted by the browser before they reach here.
 */
export const JournalActionSchema = z.object({
  v: z.literal(JOURNAL_FILE_VERSION),
  /** The command correlation id (`c<n>`) — the natural, cross-side-stable action identity. */
  actionId: z.string().min(1).max(TRANSPORT_LIMITS.MAX_REF_LENGTH),
  /** The MCP tool / command name that drove it (e.g. "reticle_act"). */
  tool: z.string().min(1).max(TRANSPORT_LIMITS.MAX_COMMAND_NAME_LENGTH),
  /** Redacted invocation args. */
  args: z.record(z.unknown()).default({}),
  /** Bounded effect summary (settle glyph, target, etc.). Kept open; narrowed by the writer. */
  effect: z.unknown().optional(),
  /** Whether the page settled within budget after the action, when known. */
  settled: z.boolean().optional(),
  /** Time from dispatch to settle in ms, when known. */
  settledInMs: z.number().int().min(0).optional(),
  /** Inclusive seq range of events attributed to this action, when any were observed. */
  seqRange: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
  /** Elapsed-ms window [dispatch, resolve] used for window attribution. */
  tRange: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }),
  /** Elapsed-ms timestamp the action was recorded at (clock injected by the writer). */
  at: z.number().int().min(0),
});
export type JournalAction = z.infer<typeof JournalActionSchema>;

/**
 * The report written beside `events.jsonl` when its byte ceiling refuses a batch.
 *
 * The event ledger is bounded on disk, and a bound means a ledger can be INCOMPLETE. The refusal is
 * declared twice on purpose, because neither declaration can do the other's job:
 *
 *  - IN-BAND, as one `TRUNCATED` record on the event stream, so every existing reader sees it with
 *    no new field and no new allowlist.
 *  - OUT-OF-BAND, as this file, because the in-band record carries a `t` and every journal-backed
 *    query filters on `t`. A window opened after the ceiling was hit contains no marker and no
 *    events, which is exactly a complete window in which nothing happened.
 *
 * Every field but `v` and `channel` is OPTIONAL, and that is a rule rather than a convenience: the
 * file's PRESENCE is the durable fact ("this ledger was closed"), while its contents are a detail
 * that a truncated or corrupted write can lose. A reader that cannot parse the details reports them
 * absent. It must never fill them in from what is true NOW — the current ceiling is not necessarily
 * the ceiling that closed the ledger — and it must never read an unparseable file as an open one.
 */
export const JournalWriteLossSchema = z.object({
  v: z.literal(JOURNAL_FILE_VERSION),
  /** Which channel lost data — the same vocabulary the in-band `TRUNCATED` record names. */
  channel: z.literal(TruncationChannel.JOURNAL),
  /** The ceiling that refused the write, in bytes. */
  capBytes: z.number().int().min(1).optional(),
  /** Bytes already in the ledger when it was closed. */
  bytesOnDisk: z.number().int().min(0).optional(),
  /**
   * Events in the ONE batch that was refused — never a running total of everything dropped after.
   *
   * An append-only file cannot revise a line it has already written, and re-emitting a fresh count
   * per refusal would recreate the growth this bound exists to stop. The load-bearing fact is that
   * the ledger closed; the count says how much was in the batch that closed it, and nothing more.
   */
  droppedInBatch: z.number().int().min(0).optional(),
  /** Elapsed-ms stamp of the last record in the first refused batch; not a loss-window boundary. */
  at: z.number().optional(),
});
export type JournalWriteLoss = z.infer<typeof JournalWriteLossSchema>;

/**
 * The bounded verdict summary a verification tool writes into a journal action's `effect`.
 *
 * `effect` is deliberately open (`unknown`) and narrowed by its writer; this is that narrowing for
 * the one writer whose record has to be READ back later. Without it a verdict lives only in the tool
 * response, which is exactly the place that disappears when an agent compacts, so "what did this run
 * already prove" would have no ledger to fold and the answer would be silently empty.
 *
 * Three fields and no more: the claim the verdict was about, how it came out, and where in the
 * source it pointed. A transcript here would grow the journal without making the answer better.
 */
export const JournalVerdictEffectSchema = z.object({
  /** What was claimed, in the caller's own words — the subject a later proof supersedes. */
  claim: z.string().min(1).max(TRANSPORT_LIMITS.MAX_STRING_LENGTH),
  /** The verdict, as the one field an agent reads. The enum, never a re-typed copy of it. */
  verified: z.nativeEnum(Verified),
  /** `file:line` for the element driven, when the page told us one. */
  source: z.string().max(TRANSPORT_LIMITS.MAX_URL_LENGTH).optional(),
  /**
   * Which source of truth answering the claim required -- the predicate's own kind.
   *
   * A run folded from this journal has to say what a check READ, and with no field here it had
   * nothing to say it from: every check ever folded was stamped `element`, including the ones whose
   * own `grade` in the same object said `net`. Channel routing reads this, so a network verdict
   * arrived as a UI verdict.
   *
   * Optional, because a record written before this field existed has no kind and must not be read
   * as though it had one.
   */
  kind: z.nativeEnum(PredicateKind).optional(),
  /**
   * Was the claim written down BEFORE the action, or after it?
   *
   * The difference between a check and a rationalisation. Recorded here because the journal is the
   * durable record a run artifact is built from: a fact that never reaches it is a fact nothing
   * downstream can ever report, however well the verdict knew it at the time.
   *
   * Absent is not `false`. `false` says the claim came afterwards; absent says nobody recorded which.
   */
  declaredBeforeActing: z.boolean().optional(),
  /**
   * What kind of evidence bought the answer -- the grade the verdict actually proved.
   *
   * A green paid for with "something matching was on screen" is not the green paid for with "the
   * request went out", and a record that keeps only the word `yes` cannot tell them apart later.
   */
  grade: z.string().max(TRANSPORT_LIMITS.MAX_STRING_LENGTH).optional(),
  /**
   * What could not be seen while this was being checked.
   *
   * The one property with no prior art: every other kind of test record is silent about its own
   * blind spots. Empty means nothing was hidden; absent means nobody looked.
   */
  couldNotSee: z.array(z.string().max(TRANSPORT_LIMITS.MAX_STRING_LENGTH)).optional(),
  /**
   * WHY the verdict came out this way, in the engine's own vocabulary.
   *
   * Without it, `unknown` is one word for facts that need opposite responses: "the outcome has
   * not arrived yet" and "the capture was dirty so I could not see" are both `unknown`, and only
   * the first can ever be answered by waiting. A reader of the record -- or a fold over it --
   * cannot tell a question that is still open from one that was never answerable.
   *
   * Optional, because a record written before this existed has no reason to offer and must not
   * be read as though it did.
   */
  reason: z.string().max(TRANSPORT_LIMITS.MAX_STRING_LENGTH).optional(),
});
export type JournalVerdictEffect = z.infer<typeof JournalVerdictEffectSchema>;
