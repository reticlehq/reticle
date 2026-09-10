/**
 * Words only the engine may say.
 *
 * `createMcpServer` accepts a `tools` table, so a host can put its own tools on the surface. A tool's
 * result is serialized to the agent as it stands, which means a tool somebody else wrote could hand
 * the agent `{ verified: "yes" }` with nothing having been verified.
 *
 * The telemetry side is already safe: a consumer tool cannot inflate the verdict metric, because that
 * is gated on a fixed list of first-party tools. The AGENT is the unprotected side, and the agent is
 * the one that acts on the answer. **The transcript is the trust boundary, not the metric.**
 *
 * So the rule is the same one that applies to a realm adapter, at the other end of the system: a tool
 * supplies observations, and only the engine turns observations into a verdict.
 */

/**
 * The result keys that carry a verdict, and therefore may only be produced by the engine.
 *
 * Deliberately short. `because` is not here: it is an ordinary English word that any tool might
 * reasonably use for its own explanation, and reserving it would cost more in false refusals than it
 * saves. These three are Reticle's own vocabulary and mean one thing.
 */
export const RESERVED_VERDICT_KEYS: ReadonlySet<string> = new Set([
  'verified',
  'verifiedReason',
  'verdict',
]);

/**
 * Which reserved words a result claims, sorted so the refusal message is identical run to run.
 *
 * Only the TOP level is checked. A tool may legitimately return data that happens to contain the
 * word -- rows read from a table, a log line quoting one -- and refusing that would make the guard
 * unusable. What a tool may not do is make a verdict claim about the action it just performed, and
 * that claim sits at the top level beside its own result.
 *
 * Anything that is not a plain object claims nothing, so it passes.
 */
export function reservedVerdictKeysIn(result: unknown): string[] {
  if (typeof result !== 'object' || null === result || Array.isArray(result)) return [];
  return Object.keys(result)
    .filter((key) => RESERVED_VERDICT_KEYS.has(key))
    .sort();
}

/**
 * The refusal a consumer tool gets when it tries to mint a verdict.
 *
 * Names the words, says who owns them, and says what to return instead -- a refusal that only says
 * "no" makes the author guess, and a guessing author reaches for a workaround.
 */
export function consumerVerdictRefusal(toolName: string, keys: readonly string[]): string {
  const words = keys.map((k) => `\`${k}\``).join(', ');
  const plural = 1 === keys.length ? 'that field is' : 'those fields are';
  return (
    `the tool "${toolName}" returned ${words}, and ${plural} reserved: only Reticle's own ` +
    'verification produces a verdict. A tool supplies OBSERVATIONS and the engine decides what they ' +
    'prove, which is what stops a green from meaning "some tool said so". Return your result under ' +
    'your own field names and let reticle_act_and_wait or reticle_assert reach the verdict.'
  );
}
