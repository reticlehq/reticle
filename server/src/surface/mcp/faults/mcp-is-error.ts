/**
 * Does a SUCCESSFUL tool result actually describe a refusal?
 *
 * A thrown handler is not the only refusal. Half the surface returns a well-formed
 * `{ error, recovery }` object instead, which is protocol SUCCESS — so `isError` set only on a throw
 * leaves anything branching on it reading a refusal as a result, and every caller special-casing
 * each tool's shape.
 *
 * A top-level `error` STRING is this codebase's refusal convention (see buildErrorPayload), so that
 * is the whole test. Deliberately top-level only: `error` appears inside console entries and network
 * rows as ordinary data, and flipping the flag for those would make it useless in the other direction.
 */
export function resultIsError(result: unknown): boolean {
  if (typeof result !== 'object' || null === result || Array.isArray(result)) return false;
  const error = (result as { error?: unknown }).error;
  return 'string' === typeof error && error.length > 0;
}
