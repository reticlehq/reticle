/** Methods that normally carry a payload — the ones where a missing body is worth explaining. */
const BODY_BEARING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Say so when a payload exists but was not recorded.
 *
 * A `reticle_network` row for a POST lists method/url/status and nothing else, and an agent reading
 * that has no way to tell "this request had no interesting payload" from "Reticle was not looking at
 * payloads". The second reading is the dangerous one: on a real payments dashboard the defect WAS
 * the payload — a refund POSTing `amount: 1187.01` into a paise field, a 100x under-refund that
 * every other field in the record agrees is a clean 200.
 *
 * So an omission is declared rather than left to inference, with the one line that fixes it. Present
 * only when a body-bearing call was returned AND no body — request or response — was recorded
 * anywhere in the result, so an app that already captures bodies pays nothing and the field's
 * PRESENCE is the warning.
 */
export function bodiesNotCaptured(
  calls: { method?: string; requestBody?: string; responseBody?: string }[],
): {
  bodiesNotCaptured?: string;
} {
  const bodyBearing = calls.filter((c) => BODY_BEARING_METHODS.has((c.method ?? '').toUpperCase()));
  if (0 === bodyBearing.length) return {};
  // A recorded response body anywhere in the result proves capture is ON. An absent request body
  // then means this payload was not stringified (a multipart upload, a body the SDK skipped), not
  // that recording is off — and firing the note would contradict the body sitting in the same
  // result, exactly on the question the note exists to answer. (#394)
  if (calls.some((c) => c.responseBody !== undefined)) return {};
  if (bodyBearing.some((c) => c.requestBody !== undefined)) return {};
  return {
    // Framework-neutral on purpose. The first version named vite.config, and driving a Next.js app
    // returned that advice verbatim for a SERVER ACTION — a POST a Next user cannot fix in a Vite
    // config they do not have. Remediation that does not apply to the reader's stack is worse than
    // none: it sends them to edit a file that is not there and reads as a tool that does not know
    // what it is looking at.
    bodiesNotCaptured:
      'request/response bodies are NOT being recorded, so an absent body here means UNSEEN, not empty — the payload of these calls was never inspected. Turn it on where your app calls connect(): `reticle.connect({ captureNetworkBodies: true })`, or for the Vite plugin `reticle({ captureNetworkBodies: true })` / VITE_RETICLE_CAPTURE_BODIES=1. Then re-run the action.',
  };
}
