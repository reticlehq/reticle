/**
 * Did a benchmark pass actually MEASURE anything, whatever shape it writes?
 *
 * `bench-all.mjs` already refuses to trust a pass's exit code — a pass can error every flow, write a
 * summary of nulls and exit 0, which is the exact failure this project exists to catch, occurring in
 * the instrument that measures it. But the check it used read `data.rows`, and only four of the
 * twelve passes write a `rows` array. The other eight write a top-level array, `points`, `runs`, or
 * nothing but scalars, and every one of them returned early as "no per-row detail — exit code is all
 * we have". The most expensive pass in the suite was in that group.
 *
 * ## What counts as evidence, and why it is tokens
 *
 * Shapes disagree; the currency does not. Every pass in this suite prices something in tokens, so a
 * finite positive token figure is the one piece of evidence that exists in all twelve artifacts.
 * That makes the rule shape-independent: a pass invented tomorrow is covered without editing this
 * file, which is the property the old guard lacked.
 *
 * The competitor re-drive figures are excluded, and that exclusion is the whole subtlety. They are
 * CONSTANTS — measured once by hand, written into the artifact every run — so a pass that measured
 * absolutely nothing still carries a large, healthy-looking token number. Counting those would leave
 * the guard inert precisely where it was already inert.
 *
 * Separate from `bench-all.mjs` so this is unit-tested; that file is a fixture-booting script with
 * top-level await and cannot be imported from a test.
 */

/** Keys that carry a measurement, by name. Every pass prices its work in tokens. */
const TOKEN_KEY = /token/i;

/** …except these, which are hand-measured competitor constants, not something this run observed. */
const CONSTANT_KEY = /redrive|competitor/i;

/** Array properties a pass uses for its per-row detail. A top-level array is handled separately. */
const ROW_KEYS = ['rows', 'points', 'runs'];

/** Every finite, positive number recorded under a token-ish key, at any depth. */
function tokenMeasurements(node, key = '') {
  if ('number' === typeof node) {
    return TOKEN_KEY.test(key) && !CONSTANT_KEY.test(key) && Number.isFinite(node) && node > 0
      ? 1
      : 0;
  }
  if (Array.isArray(node)) {
    return node.reduce((n, item) => n + tokenMeasurements(item, key), 0);
  }
  if (null !== node && 'object' === typeof node) {
    return Object.entries(node).reduce((n, [k, v]) => n + tokenMeasurements(v, k), 0);
  }
  return 0;
}

/** The per-row detail this artifact carries, or null when it reports none. */
function rowsOf(data) {
  if (Array.isArray(data)) return data;
  for (const key of ROW_KEYS) {
    if (Array.isArray(data[key])) return data[key];
  }
  return null;
}

/**
 * Returns `{ ok, reason }` rather than throwing, matching the other gate rules: the caller decides
 * whether one failure is fatal, and the reason is written for whoever has to re-run the pass.
 */
export function measurementVerdict(data) {
  if (null === data || 'object' !== typeof data) {
    return { ok: false, reason: 'is not a JSON object or array, so it records no measurements' };
  }

  const rows = rowsOf(data);
  if (null !== rows) {
    if (0 === rows.length) return { ok: false, reason: 'measured NOTHING — it has no rows' };
    const measured = rows.filter((row) => null !== row && undefined === row?.error);
    if (0 === measured.length) {
      const firstError = rows.find((row) => undefined !== row?.error)?.error;
      return {
        ok: false,
        reason: `measured NOTHING — all ${String(rows.length)} row(s) errored, first: ${String(firstError).slice(0, 160)}`,
      };
    }
  }

  // The shape-independent half: rows or no rows, a pass that measured something priced it.
  if (0 === tokenMeasurements(data)) {
    return {
      ok: false,
      reason:
        'measured NOTHING — it records no token figure of our own above zero. Every pass prices its ' +
        'work in tokens, so an artifact without one is a summary of nulls: the pass ran, the flows ' +
        'failed, and it exited 0 anyway. Re-run it rather than reading its numbers.',
    };
  }

  return { ok: true, reason: 'measured at least one row and one token figure' };
}
