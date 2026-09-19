/**
 * What a caller may offer the intent ledger, checked before the ledger is touched.
 *
 * The advertised `reticle_intent` schema is not this check. An MCP client validates against the
 * schema the tool publishes, but `reticle_run { tool, args }` — the escape hatch every unadvertised
 * tool is reached through — only verifies that the argument NAMES are ones the target declares. The
 * shapes behind those names arrive unread, so `surface: "/authorize"` where the ledger requires
 * `{ route: "/authorize" }` reached the store as a string and was serialised into
 * `.reticle/intent.json` (#994).
 *
 * A malformed row is not a malformed row for long. Both readers fail SOFT — `parseIntentFile` and
 * `readJsonFile` answer with an empty document rather than throwing, because a git-checked file a
 * human can hand-merge really does arrive with a conflict marker in it, and taking a verdict down
 * over one would trade a small problem for a large one. So one bad field makes the whole file
 * unreadable, every later read reports an empty ledger, and the next read-modify-write persists that
 * emptiness over every intent the project had. The loss is silent in both directions.
 *
 * The check therefore belongs at the STORE, not at the tool: it is the one place all four doors
 * (`reticle_intent`, `reticle_run`, an inline `intent` on a verdict, a saved flow's goal) already
 * pass through, and a fifth door added later inherits it instead of having to remember it.
 *
 * Both schemas are DERIVED from the ones the files are read back with rather than restated beside
 * them. A hand-written copy of a schema is a copy that drifts, and drift between what is written and
 * what can be read back is precisely this defect.
 */
import { z } from 'zod';
import { ReticleTool } from '@reticlehq/core';
import { IntentSchema } from '@reticlehq/core/artifacts';
import { IntentRecordSchema, IntentStatusSchema } from './intent-shard.js';

/** What `declare` accepts per entry: the ledger's own fields, minus the ones the store derives. */
export const IntentDeclarationSchema = IntentSchema.pick({
  id: true,
  statement: true,
  surface: true,
});
export type IntentDeclaration = z.infer<typeof IntentDeclarationSchema>;

const IntentDeclarationBatchSchema = z.array(IntentDeclarationSchema);

/**
 * What `record` accepts: the stored record, minus what the store decides for itself.
 *
 * `status` is optional on the way in because the store defaults it, and `subject` is optional AND
 * unconstrained because `subjectFor` derives one from whatever evidence the record carries — a
 * caller that cannot name a subject is the normal case, not an error.
 */
export const IntentRecordInputSchema = IntentRecordSchema.pick({
  id: true,
  statement: true,
  why: true,
  source: true,
  surface: true,
  binding: true,
}).extend({
  status: IntentStatusSchema.optional(),
  subject: z.string().optional(),
});
export type IntentRecordInput = z.infer<typeof IntentRecordInputSchema>;

/** The argument each refusal names, so an agent knows which field of its call to fix. */
const DECLARATIONS = 'intents';
const RECORD = 'record';

/**
 * Said on every refusal, because the agent's next move depends on it.
 *
 * Without it the honest reading of an error is "something went wrong part-way through a write", and
 * the recovery for that is to inspect or re-declare the ledger — which is how a reporter spent a
 * session. The whole point of checking before the lock is that there is nothing to recover.
 */
const NOTHING_WRITTEN = 'NOTHING was written, so the ledger on disk is unchanged';

/** `[0].surface` — the path an agent can find in the arguments it sent, not zod's array of keys. */
const pathOf = (path: readonly (string | number)[]): string =>
  path.map((step) => ('number' === typeof step ? `[${String(step)}]` : `.${step}`)).join('');

/**
 * Refuse, in the wording `error-recovery.ts` already classifies as an ARGUMENT rejection.
 *
 * That file decides what an agent is told next by reading the message, and an error it does not
 * recognise is answered with "this may be a defect in Reticle" plus an ask to file a bug report.
 * For a caller's own malformed argument that is both wrong and expensive: it spends a turn and
 * fills the feedback channel with reports about typos. `reticle_run`'s own refusal is phrased
 * `unknown parameters for <tool>: …` for exactly this reason, so this is the same sentence for the
 * neighbouring mistake.
 *
 * It names `reticle_intent` even though `IntentStore` is also written to by a saved flow's goal and
 * by an inline `intent` on a verdict. Both of those swallow a refusal by design — a ledger that
 * cannot be written must never be why a verdict fails to return — so the tool is the only door this
 * sentence is ever read through.
 */
function refuse(field: string, error: z.ZodError): never {
  const problems = error.issues.map((issue) => `${field}${pathOf(issue.path)}: ${issue.message}`);
  throw new Error(
    `invalid ${1 === problems.length ? 'parameter' : 'parameters'} for ${ReticleTool.INTENT}: ` +
      `${problems.join('; ')} — ${NOTHING_WRITTEN}`,
  );
}

/**
 * Every declaration in a batch, or a refusal naming the first thing wrong with it.
 *
 * The WHOLE batch is checked before any of it is returned, so a call declaring five intents with one
 * bad entry writes none of them. Half a batch on disk is the worse answer of the two: the agent is
 * told the call failed, the ledger disagrees, and which is true depends on the order of an array.
 *
 * An absent `intents` is an empty batch rather than a refusal — `{ action: "declare" }` has always
 * answered "declared nothing" and writes nothing either way. A PRESENT `intents` that is not an
 * array is refused, because that is a caller who meant to declare something and did not.
 */
export function parseDeclarations(raw: unknown): IntentDeclaration[] {
  if (undefined === raw) return [];
  const parsed = IntentDeclarationBatchSchema.safeParse(raw);
  if (!parsed.success) refuse(DECLARATIONS, parsed.error);
  return parsed.data;
}

/** One record's input, or a refusal naming what is wrong with it. */
export function parseRecordInput(raw: unknown): IntentRecordInput {
  const parsed = IntentRecordInputSchema.safeParse(raw);
  if (!parsed.success) refuse(RECORD, parsed.error);
  return parsed.data;
}
