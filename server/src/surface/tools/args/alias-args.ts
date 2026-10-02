/**
 * Accepting a neighbouring tool's spelling for the same parameter.
 *
 * Reticle's surface has a few places where one concept has two names, and every one of them is a
 * rejected call for an agent that learned the other spelling from the tool next door:
 *
 *   reticle_act_and_wait { until }  vs  reticle_wait_for / reticle_assert { predicate }
 *   reticle_annotate     { flow }   vs  every other flow tool          { flowName }
 *
 * Both cross a path the product prescribes — `act_and_wait` is the most-used tool, and
 * `reticle_flow_save`'s own description tells the agent to go and call `reticle_annotate`.
 *
 * Aliasing, not renaming: the canonical name stays the contract, an explicit canonical value always
 * wins, and a call carrying neither is left untouched so the schema error still names what was
 * missing instead of being replaced by a guess.
 */
export function aliasParam(
  args: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[],
): Record<string, unknown> {
  if (args[canonical] !== undefined) return args;
  for (const alias of aliases) {
    if (args[alias] !== undefined) return { ...args, [canonical]: args[alias] };
  }
  return args;
}
