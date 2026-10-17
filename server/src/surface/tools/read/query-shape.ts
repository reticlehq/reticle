/**
 * Accepting the element-query shape the rest of the surface teaches.
 *
 * `reticle_query` asks for a strategy and a value — `{ by: 'text', value: 'Deploy' }`. Every
 * predicate asks for named fields — `{ text: 'Deploy' }`, `{ testid: 'submit' }` — and that is where
 * an agent meets element queries most often (`act_and_wait { until: { kind:'element', query } }`,
 * `reticle_assert`, `wait_for`). Carrying the predicate's spelling to `reticle_query` earns
 * `-32602: Unknown parameter for reticle_query: text`.
 *
 * It is a small thing that lands in an expensive place: of the sessions that called any tool in a
 * day, HALF made exactly one call and stopped. A rejected first call is a bounced session, and the
 * agent has no way to know the rejection was about spelling rather than the page.
 *
 * Translation only — `by`/`value` remain the tool's contract, an explicit pair always wins, and a
 * call carrying neither shape is left alone so the schema error still explains itself rather than
 * being replaced by a confident wrong query.
 */

/** Most specific first: the order Reticle prefers anchors everywhere else (testid is gold). */
const FIELD_TO_STRATEGY: readonly (readonly [string, string])[] = [
  ['testid', 'testid'],
  ['label', 'label'],
  ['placeholder', 'placeholder'],
  ['alt', 'alt'],
  ['text', 'text'],
  ['role', 'role'],
];

export function normalizeQueryArgs(args: Record<string, unknown>): Record<string, unknown> {
  // An explicit pair is the contract; never second-guess it.
  if ('string' === typeof args['by'] && 'string' === typeof args['value']) return args;
  for (const [field, strategy] of FIELD_TO_STRATEGY) {
    const value = args[field];
    if ('string' === typeof value && value.length > 0) {
      // `name` stays as-is: with role it is the accessible-name filter the predicate also uses.
      return { ...args, by: strategy, value };
    }
  }
  return args;
}

/** How the refusal of an empty find opens: the error table recognizes it by these words. */
export const EMPTY_FIND_OPENING = 'Nothing was searched: this find names nothing to find.';

/**
 * The error for a query that names nothing to find, or `undefined` when it names something.
 *
 * Sent to the page, an empty query answered `count: 0`, which reads as "nothing here matches" about
 * a question nobody asked. A container asked for itself (`self`) needs no other field.
 */
export function emptyQueryRefusal(args: Record<string, unknown>): Error | undefined {
  if (true === args['self'] || 'string' === typeof args['by'] || 'string' === typeof args['value'])
    return undefined;
  return new Error(
    `${EMPTY_FIND_OPENING} Pass one of testid, text, role ` +
      '(with name), label, placeholder or alt, e.g. { testid: "submit" } or { role: "button", ' +
      'name: "Save" }, or `by` with `value`.',
  );
}
