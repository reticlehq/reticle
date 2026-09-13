/**
 * Does a SUCCESSFUL tool result actually describe a refusal?
 *
 * `isError` used to be set only when a handler threw. Every tool that returns a well-formed
 * `{ error, recovery }` object instead — and that is half the surface — came back as protocol
 * success with the flag unset, so anything branching on `isError` read a refusal as a result.
 * Reported from a field sweep that had to special-case each tool's shape to score a run at all.
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
