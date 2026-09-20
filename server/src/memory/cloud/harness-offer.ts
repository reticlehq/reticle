/**
 * Whether this workspace has taken the three months of free harness, read by the thing that would
 * advertise it.
 *
 * The HUD can only advertise honestly if it knows, and only the platform knows. This is the read —
 * filed beside the other reads of the linked account rather than with the harness itself, because
 * nothing that DRIVES needs it; the thing that needs it is the snapshot the HUD paints from. Same
 * shape as the harness's own `platform-config.ts` and for the same reasons: it is INFORMATION, not a
 * credential, so every failure answers `undefined`, which every caller must treat as "say nothing"
 * rather than as "not claimed". An offline laptop must not start advertising something the person
 * already owns.
 *
 * It is also SYNCHRONOUS at the point of use. The impact snapshot is built inline, dozens of times a
 * session, and the answer changes about once per workspace lifetime, so a cache that refreshes in
 * the background is the whole design: readers get what we last heard, and a stale answer is only
 * ever stale in the safe direction — the card the person is looking at is the one they can act on.
 */

import { ReticleEnv, apiKeyFrom, type HarnessOffer } from '@reticlehq/core';

const OFFER_PATH = '/v1/harness/offer';

/** Same budget as the model-config read: a drive must never wait on an advert. */
const TIMEOUT_MS = 2_000;

/**
 * How long a cached answer is trusted.
 *
 * A claim happens once. The only transition worth catching quickly is the one the person just made
 * in another tab, and ten minutes is well inside the time it takes them to come back and look.
 */
const FRESH_MS = 10 * 60 * 1_000;

/** A GET, narrowed to what this file uses, so a test can answer it without a network. */
export type OfferFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Parse the platform's answer.
 *
 * The platform reports `null` for "never claimed" on the fields it has no value for; the wire
 * contract says ABSENT. They are the same fact and the translation belongs here, at the edge,
 * rather than in a HUD that would then need to know about two spellings of nothing.
 */
function parse(body: string, claimUrl: string | undefined): HarnessOffer | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if ('object' !== typeof parsed || null === parsed) return undefined;
    const record = parsed as Record<string, unknown>;
    const claimed = record['claimed'];
    if ('boolean' !== typeof claimed) return undefined;
    const offer: HarnessOffer = { claimed };
    const expiresAt = record['expiresAt'];
    if ('number' === typeof expiresAt) offer.expiresAt = expiresAt;
    const days = record['daysRemaining'];
    if ('number' === typeof days) offer.daysRemaining = days;
    // The one field that cannot be inferred from the others: a LAPSED claim reports `claimed:false`
    // and `daysRemaining:0`, which is indistinguishable from never having claimed unless the
    // platform's own answer about offerability is carried through.
    const eligible = record['eligible'];
    if ('boolean' === typeof eligible) offer.eligible = eligible;
    if (claimUrl !== undefined && 0 < claimUrl.length) offer.claimUrl = claimUrl;
    return offer;
  } catch {
    return undefined;
  }
}

/** Ask the platform where this workspace stands. `undefined` means "no answer", never "not claimed". */
export async function fetchHarnessOffer(
  env: Record<string, string | undefined>,
  claimUrl: string | undefined,
  doFetch: OfferFetch = (url, init) => fetch(url, init),
  timeoutMs: number = TIMEOUT_MS,
): Promise<HarnessOffer | undefined> {
  const key = apiKeyFrom(env);
  const host = env[ReticleEnv.CLOUD_URL];
  if (key === undefined || 0 === key.length) return undefined;
  if (host === undefined || 0 === host.length) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await doFetch(`${host.replace(/\/+$/, '')}${OFFER_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    return parse(await res.text(), claimUrl);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** What the impact snapshot reads: the last answer, with a refresh kicked off when it goes stale. */
export interface OfferSource {
  read(): HarnessOffer | undefined;
}

/**
 * A self-refreshing cache over the read above.
 *
 * Deliberately NOT a timer. A daemon that lives for days would otherwise hold an interval whose only
 * job is to re-ask a question nobody is asking, and it would have to be torn down in a place that
 * already has nine teardowns. Refreshing on a stale READ means the work only happens while somebody
 * is actually looking, and the first read of a process — which is always stale — starts the fetch
 * that the second read answers from.
 */
export function harnessOfferSource(
  env: Record<string, string | undefined>,
  claimUrl: () => string | undefined,
  now: () => number = () => Date.now(),
  load: (claim: string | undefined) => Promise<HarnessOffer | undefined> = (claim) =>
    fetchHarnessOffer(env, claim),
): OfferSource {
  let cached: HarnessOffer | undefined;
  // `undefined` rather than 0: "never asked" is a different state from "asked at the epoch", and
  // conflating them made a source with an injected clock never take its first read.
  let fetchedAt: number | undefined;
  let inFlight = false;

  const refresh = (): void => {
    if (inFlight) return;
    inFlight = true;
    void load(claimUrl())
      .then((offer) => {
        // A failed read keeps the LAST good answer rather than blanking the card mid-session: one
        // dropped request is not evidence that the offer changed.
        if (offer !== undefined) cached = offer;
        fetchedAt = now();
      })
      .catch(() => {
        fetchedAt = now();
      })
      .finally(() => {
        inFlight = false;
      });
  };

  /*
   * Asked once at construction, not first read.
   *
   * Measured in a browser: a daemon pushes the impact snapshot the INSTANT a session attaches, and
   * on a page nobody drives that is the only push there will ever be. Refreshing on the first read
   * meant that push always carried "we have not heard", the answer landed a moment later with
   * nobody to tell, and the HUD showed nothing for the whole session. Starting the fetch when the
   * daemon starts puts the answer in place before any page can connect.
   */
  refresh();

  return {
    read(): HarnessOffer | undefined {
      if (fetchedAt === undefined || FRESH_MS <= now() - fetchedAt) refresh();
      return cached;
    },
  };
}
