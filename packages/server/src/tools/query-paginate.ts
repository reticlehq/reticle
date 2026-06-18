/**
 * Token-efficiency for iris_query: a `by=role value=button` on a busy page can return dozens of
 * element descriptors the agent must read in full. This trims the result the AGENT sees — the most
 * expensive part of a tool call is the bytes that land in its context.
 *
 * - count_only: drop the elements array entirely, return just `count` (the agent often only needs
 *   "how many?" — e.g. "are there 3 rows now?").
 * - limit: keep the first N descriptors, report `total` + `truncated:true` so the trim is never
 *   silent (the agent knows to narrow with name/scope rather than assume it saw everything).
 *
 * Pure and result-shape-tolerant: anything that is not a `{ elements: [...] }` object passes
 * through untouched (a thrown-error envelope, a zero-match hint result, etc.).
 */
export function paginateQueryResult(
  result: unknown,
  limit: number | undefined,
  countOnly: boolean,
): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const record = result as Record<string, unknown>;
  const elements = record['elements'];
  if (!Array.isArray(elements)) return result;
  const total = elements.length;

  if (countOnly) {
    const { elements: _dropped, ...rest } = record;
    return { ...rest, count: total };
  }

  if (limit !== undefined && limit >= 0 && total > limit) {
    return { ...record, elements: elements.slice(0, limit), total, truncated: true };
  }

  return result;
}
