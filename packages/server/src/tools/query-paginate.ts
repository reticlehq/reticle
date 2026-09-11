/**
 * Token-efficiency for reticle_query: a `by=role value=button` on a busy page can return dozens of
 * element descriptors the agent must read in full. This trims the result the AGENT sees — the most
 * expensive part of a tool call is the bytes that land in its context.
 *
 * - count_only: drop the elements array entirely, return just `count` (the agent often only needs
 * "how many?" — e.g. "are there 3 rows now?").
 * - limit: keep the first N descriptors, report `total` + `truncated:true` so the trim is never
 * silent (the agent knows to narrow with name/scope rather than assume it saw everything).
 *
 * Pure and result-shape-tolerant: anything that is not a `{ elements: [...] }` object passes
 * through untouched (a thrown-error envelope, a zero-match hint result, etc.).
 *
 * WHY THE COUNT IS NOT `elements.length`: the browser counts matches against the live DOM and puts
 * that number in `count` before the reply is serialized. The wire sanitizer then caps the elements
 * ARRAY (200 items, plus a node budget that bites sooner on rich descriptors). On a page with
 * thousands of matches the array that arrives here is therefore shorter than the truth, and deriving
 * the count from it reports the transport's cap as though it were the answer — an authoritative-looking
 * number that is silently wrong. `count` survives because it is a scalar. Trust it over the array.
 */
export function paginateQueryResult(
  result: unknown,
  limit: number | undefined,
  countOnly: boolean,
): unknown {
  if (typeof result !== 'object' || null === result) return result;
  const record = result as Record<string, unknown>;
  const elements = record['elements'];
  if (!Array.isArray(elements)) return result;

  const counted = record['count'];
  // Older browser SDKs (and the zero-match hint path) may not carry `count`; fall back rather than
  // report nothing, but never prefer the array when the browser told us the real number.
  const total = 'number' === typeof counted ? counted : elements.length;
  const truncatedOnWire = total > elements.length;

  if (countOnly) {
    const { elements: _dropped, ...rest } = record;
    // `truncated` here means "the sample was capped in transit", not "the count is approximate" —
    // the count is exact. It is surfaced so the agent knows not to re-derive anything from a sample.
    return truncatedOnWire ? { ...rest, count: total, truncated: true } : { ...rest, count: total };
  }

  if (limit !== undefined && limit >= 0 && total > limit) {
    return { ...record, elements: elements.slice(0, limit), total, truncated: true };
  }

  // No limit was asked for, but the wire capped the array anyway. Saying nothing here is what let a
  // partial list read as complete.
  if (truncatedOnWire) return { ...record, total, truncated: true };

  return result;
}
