/**
 * Whether a network call's body earns the bytes it costs.
 *
 * `reticle_network` was the most expensive read an agent makes: measured on a connected drive of the
 * bench app with body capture ON, that one tool returned 59,458 bytes and was 90.9% of every byte
 * the drive spent.
 *
 * It is NOT true that bodies dominate it, and that claim is retracted here rather than quietly
 * dropped, because it is what motivated this file and it was written into the tool's own
 * description. Re-measured with the DEFAULT configuration — capture off — the same tool returned 200
 * calls and 28,408 bytes with ZERO bodies, and 68% of those bytes were URLs. So this gating is
 * correct and INERT until somebody turns capture on; the bulk is the number of dev-server asset
 * calls, which is what `asset-noise.ts` addresses.
 *
 * The flag to avoid that already existed and defaulted the expensive way, which is the same defect
 * in a different costume — an optional saving nobody is told about is a saving nobody takes. So the
 * DEFAULT moves and the question becomes "could this body change a verdict".
 *
 * The line this must not cross is the one `lean` crossed: dropping evidence to save tokens fixed 3
 * of 5 bugs against the full surface's 5 and produced this project's first measured false green.
 * Bodies are therefore kept for every call that FAILED (the body is where the reason lives), for
 * every call whose outcome cannot be scored at all (no status, or an explicit `ok:false` — treating
 * unknown as success is how an unverifiable call becomes an assumed one), and for any call the
 * caller named through a filter, because naming a call IS asking about it. What is dropped is the
 * body of a plain success nobody mentioned.
 */

/** How much body detail the caller wants. `auto` keeps only what could decide a verdict. */
export type BodyMode = 'all' | 'none' | 'auto';

/** The fields of a captured call this decision reads. Deliberately structural, not a class. */
export interface ScorableCall {
  readonly status?: number | string | undefined;
  readonly ok?: boolean | undefined;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly contentType?: string | undefined;
}

/**
 * Methods that CHANGE something. Their bodies are the evidence that they changed the right thing.
 *
 * A successful `POST /api/todos -> {"id":7}` is the answer to "did that click create the todo",
 * which is the question the whole tool exists for. An earlier version of this rule kept bodies on
 * failures only, and dropped that one — the repo's own test caught it, which is what that test is
 * for.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * What a dev server serves that nobody asked about: modules, styles, maps, and Vite's own plumbing.
 *
 * This is the actual bulk. Measured on a connected drive of the bench app, 200 calls averaged 142
 * bytes and 68% of the payload was URLs of exactly this kind — `/src/main.tsx`, `/@vite/client`,
 * `/node_modules/.vite/deps/...`. They carry no verdict and are the reason the tool cost 28,408
 * bytes on that drive.
 *
 * Exported because the same question is asked twice: whether to keep this call's BODY, and whether
 * to list the call at all. One regular expression, so the two answers cannot drift apart and start
 * disagreeing about what an asset is.
 */
export const ASSET_URL =
  /\.(m?[jt]sx?|css|map|woff2?|png|jpe?g|svg|gif|ico|webp|avif)(\?|$)|\/@vite\/|\/node_modules\//i;

/** True when the caller's filters singled this call out, so its body is the thing being asked about. */
export interface BodyContext {
  readonly named?: boolean;
}

/** A 2xx/3xx HTTP status. Anything else — including a string, or nothing — is not a plain success. */
function isSuccessStatus(status: number | string | undefined): boolean {
  if ('number' !== typeof status) return false;
  return status >= 200 && status < 400;
}

export function bodyIsEvidence(
  call: ScorableCall,
  mode: BodyMode,
  context: BodyContext = {},
): boolean {
  if ('all' === mode) return true;
  if ('none' === mode) return false;
  // A call the caller singled out is one they are asking about; withholding its body answers a
  // different question than the one asked.
  if (true === context.named) return true;
  if (false === call.ok) return true;
  // Not scorable — no status at all (desktop IPC fire-and-forget) — so the body is the only evidence
  // there is. Keeping it is the difference between "outcome unknown" and "outcome assumed fine".
  if (!isSuccessStatus(call.status)) return true;
  // A mutation's body says WHAT it changed, which no other field carries.
  if (MUTATING.has((call.method ?? '').toUpperCase())) return true;
  // Anything the app exchanged as data, rather than something the browser fetched to run.
  if ((call.contentType ?? '').toLowerCase().includes('json')) return true;
  // What is left is a successful GET of something that looks like a build artifact.
  return !ASSET_URL.test(call.url ?? '');
}
