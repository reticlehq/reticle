import { z } from 'zod';

/**
 * What a change was supposed to make true, captured while somebody still knows.
 *
 * An agent building a feature knows what it is for — which user does what, what should become true,
 * what the failure looks like. That knowledge lives in its context, and then the turn ends. Later, a
 * different turn or a different model drives the app and has to decide whether the feature works,
 * holding the DOM, the diff, and no intent. So it asserts what it can SEE rather than what was
 * MEANT, and what it can see is almost always weaker. That gap is where a false green comes from.
 *
 * ## Prose early, predicate late
 *
 * Fidelity is highest the moment the human asks and decays from there. Bindability — whether it can
 * be written as something checkable — is near zero then and rises as the code appears. So
 * `statement` is prose and mandatory, and `binding` is a predicate, optional, arriving later or
 * never. An intent that stays `declared` is not a failure: it names something the team meant that
 * nothing can currently prove.
 *
 * ## Amendments are append-only
 *
 * A long build changes its mind, so an intent must be amendable — and an amendable intent is also
 * how an agent could quietly rewrite what it meant to match what it can already prove. Keeping the
 * previous statement makes a NARROWING visible in the git diff. That is a PARTIAL defence and the
 * only one there is.
 */

export const INTENT_FILE_VERSION = 1;

export const IntentState = {
  /** Prose only. Nothing yet says how it would be proved. */
  DECLARED: 'declared',
  /** A predicate exists that would prove it. */
  BOUND: 'bound',
  /** A verdict satisfied that predicate. */
  PROVED: 'proved',
} as const;
export type IntentState = (typeof IntentState)[keyof typeof IntentState];

/** Where the intent lives, so a later run can find the ones relevant to what it is touching. */
export const IntentSurfaceSchema = z.object({
  route: z.string().optional(),
  flow: z.string().optional(),
  files: z.array(z.string()).optional(),
});
export type IntentSurface = z.infer<typeof IntentSurfaceSchema>;

/** Which verdict discharged it, and how strongly. The grade is what makes a later weakening visible. */
export const IntentProofSchema = z.object({
  verdictId: z.string(),
  grade: z.string(),
  at: z.number(),
});

export const IntentSchema = z.object({
  id: z.string().min(1),
  /** The prose. Survives even when the binding rots, which is most of the point. */
  statement: z.string().min(1),
  state: z.enum([IntentState.DECLARED, IntentState.BOUND, IntentState.PROVED]),
  declaredAt: z.number(),
  /** Left as `unknown`: core must not depend on the server's predicate vocabulary. */
  binding: z.unknown().optional(),
  surface: IntentSurfaceSchema.optional(),
  provenBy: IntentProofSchema.optional(),
  /** Every statement this intent previously carried, oldest first. Append-only, never rewritten. */
  amended: z.array(z.object({ statement: z.string(), at: z.number() })).optional(),
});
export type Intent = z.infer<typeof IntentSchema>;

export const IntentFileSchema = z.object({
  version: z.literal(INTENT_FILE_VERSION),
  intents: z.record(z.string(), IntentSchema),
});
export type IntentFile = z.infer<typeof IntentFileSchema>;

export function emptyIntentFile(): IntentFile {
  return { version: INTENT_FILE_VERSION, intents: {} };
}

export function declareIntent(input: {
  id: string;
  statement: string;
  now: number;
  surface?: IntentSurface;
}): Intent {
  return {
    id: input.id,
    statement: input.statement,
    state: IntentState.DECLARED,
    declaredAt: input.now,
    ...(input.surface === undefined ? {} : { surface: input.surface }),
  };
}

/** Attach the predicate that would prove it. Pure — returns a new intent. */
export function bindIntent(intent: Intent, binding: unknown): Intent {
  // The same check again — what re-saving a flow does — leaves a proved intent proved.
  // ponytail: JSON equality, so key order matters; both bindings come from the same writers.
  if (JSON.stringify(intent.binding) === JSON.stringify(binding)) return intent;
  // A different check has proved nothing yet, whatever the old one did.
  const { provenBy: _proof, ...unproved } = intent;
  return { ...unproved, state: IntentState.BOUND, binding };
}

/**
 * Record that a verdict proved it.
 *
 * Refuses on an intent with no binding, and returns it unchanged rather than throwing: nothing could
 * have satisfied a predicate that does not exist, so a discharge there would be a claim with no
 * evidence — the shape this whole feature exists to stop. A throw would be the wrong shape too,
 * because discharge runs off the back of a verdict and must never be why one fails to return.
 */
export function dischargeIntent(
  intent: Intent,
  proof: { verdictId: string; grade: string; at: number },
): Intent {
  if (intent.binding === undefined) return intent;
  return { ...intent, state: IntentState.PROVED, provenBy: proof };
}

/**
 * What declaring an intent that may already exist should leave stored.
 *
 * Declaring is what a re-run does — a flow re-saved, a feature's intents declared again in a later
 * session — and it replaced the record outright, so a proved rule lost its check and its proof every
 * time somebody said it again. Same words: nothing about the promise changed, so nothing is
 * discarded. Different words: the check usually survives a rewording, the proof cannot, because it
 * was evidence for words that are gone. The amendment itself is recorded by `upsertIntent`.
 */
export function redeclareIntent(existing: Intent | undefined, fresh: Intent): Intent {
  if (existing === undefined) return fresh;
  const surface = existing.surface ?? fresh.surface;
  const withSurface = surface === undefined ? {} : { surface };
  if (existing.statement === fresh.statement) return { ...existing, ...withSurface };
  const { provenBy: _proof, ...unproved } = existing;
  return {
    ...unproved,
    statement: fresh.statement,
    state: existing.binding === undefined ? IntentState.DECLARED : IntentState.BOUND,
    ...withSurface,
  };
}

/**
 * Add or amend an intent, keeping the previous statement in its history.
 *
 * An amendment is recorded only when the statement actually changed — re-declaring the same intent
 * unchanged is what a re-run does, and filling the history with identical rows would bury the one
 * amendment somebody needs to see.
 */
export function upsertIntent(file: IntentFile, intent: Intent): IntentFile {
  const previous = file.intents[intent.id];
  const changed = previous !== undefined && previous.statement !== intent.statement;
  const amended = changed
    ? [...(previous.amended ?? []), { statement: previous.statement, at: previous.declaredAt }]
    : previous?.amended;
  return {
    version: INTENT_FILE_VERSION,
    intents: {
      ...file.intents,
      [intent.id]: { ...intent, ...(amended === undefined ? {} : { amended }) },
    },
  };
}

/** Everything not yet proved — what an agent asking "am I done?" still owes. */
export function openIntents(file: IntentFile): Intent[] {
  return Object.values(file.intents).filter((intent) => intent.state !== IntentState.PROVED);
}

/** Parse an intent file, failing soft to empty. Never throws — a cache must not take a daemon down. */
export function parseIntentFile(raw: unknown): IntentFile {
  const parsed = IntentFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyIntentFile();
}
