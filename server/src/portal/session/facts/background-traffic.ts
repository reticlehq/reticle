/** The key a project writes in `.reticle.json`. */
const BACKGROUND_KEY = 'background';

/**
 * Shorter than this names no endpoint. `/` and `//` are refused on this rule, and so is anything a
 * mistype could leave behind.
 *
 * ponytail: a length floor, not a proof. `/api` passes and would still exclude the whole backend;
 * the entries a verdict ignored are reported on it, which is what keeps a too-broad pattern visible.
 */
const MIN_PATTERN_LENGTH = 3;

function isEndpointPattern(value: unknown): value is string {
  return 'string' === typeof value && value.replace(/\//g, '').length >= MIN_PATTERN_LENGTH - 1;
}

/**
 * Read `background` out of an already-parsed `.reticle.json`: the same-origin endpoints the app calls
 * on its own (telemetry, heartbeats), which must not hold a settle window open or contradict a claim.
 *
 * Takes the record rather than a path, like `readRetainPolicy`, because the config search belongs to
 * the startup code that already does it once. Never throws, and drops a bad entry rather than the
 * whole list.
 */
export function readBackgroundTraffic(config: Record<string, unknown> | undefined): string[] {
  const raw = config?.[BACKGROUND_KEY];
  return Array.isArray(raw) ? raw.filter(isEndpointPattern) : [];
}
