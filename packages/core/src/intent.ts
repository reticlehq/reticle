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
 * ## Why the prose is captured early and the predicate late
 *
 * Intent has two properties that move in opposite directions over the life of a task.
 *
 * **Fidelity** is highest the moment the human asks and decays from there; every later restatement
 * is a lossy re-derivation. **Bindability** — whether it can be written as something checkable — is
 * near zero then, because there is no route, no ref and often no code, and rises as the code
 * appears.
 *
 * Capture at either end alone loses one of them. Demanding a predicate at declare time collects
 * MECHANISMS, which is what assertions already are. Waiting until drive time collects a
 * RE-DERIVATION, which is the weak artifact this exists to replace — by then the agent has already
 * forgotten, and that is the entire premise.
 *
 * So: `statement` is prose and mandatory. `binding` is a predicate, optional, and may arrive later
 * or never. An intent that stays `declared` and never becomes `bound` is not a failure — it is the
 * most interesting row in the ledger, because it names something the team meant that nothing can
 * currently prove.
 *
 * ## Amendments are append-only
 *
 * A long build changes its mind, so an intent must be amendable. But an amendable intent is also how
 * an agent could quietly rewrite what it meant to match what it can already prove. Keeping the
 * previous statement makes a NARROWING visible in the git diff, which is the only real defence —
 * and it is a partial one, stated here rather than papered over.
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
  return { ...intent, state: IntentState.BOUND, binding };
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
 * Add or amend an intent, keeping what it used to say.
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
