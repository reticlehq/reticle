import { EventType, urlForMatch, type ReticleEvent } from '@reticlehq/core';

/**
 * Folding the browser's own view of a network request together with the daemon's.
 *
 * Two things watch the same request. The page-side wrapper sees what the app asked for; the daemon,
 * when it drives the browser itself, sees what actually went over the wire. This puts the two
 * records back together into one event, so a reader is not left comparing two half-pictures.
 *
 * It sits with the rules that decide a verdict, not with the code that collects observations,
 * because it is a decision about what happened rather than a way of finding out. Anything the rules
 * need has to travel with them.
 *
 * Example: the app sends `{"qty":"2"}` and the wire carries `{"qty":2}`. The merged event keeps the
 * wire value and marks `requestBodyDivergedFromPage`, so the disagreement survives instead of one
 * side quietly winning.
 */

/**
 * The merge key: method plus the RAW url when the observation kept one, else the displayed url.
 *
 * Never the displayed url alone. The two sides redact independently, the SDK under the page's own
 * policy and this module under the daemon's, so the one field they were being compared on is the one
 * field redaction is allowed to rewrite. Keying on `urlForMatch` compares what was actually
 * requested, which is identical on both sides by construction.
 */
function keyOf(data: Record<string, unknown>): string {
  const method = data['method'];
  const m = 'string' === typeof method ? method.toUpperCase() : '';
  return `${m} ${urlForMatch(data)}`;
}

/**
 * Fold each NET_DETAIL onto the matching in-page NET_REQUEST (by method+url), enriching it with the
 * authoritative headers/resourceType the page-side wrapper couldn't see — WITHOUT clobbering fields the
 * in-page event already carries. A NET_DETAIL with no matching request is kept as its own event (a
 * response the wrapper missed is signal, never silently dropped). Pure over the event list.
 */
export function mergeNetworkDetail(events: readonly ReticleEvent[]): ReticleEvent[] {
  const requestByKey = new Map<string, ReticleEvent>();
  for (const e of events) {
    if (e.type === EventType.NET_REQUEST) requestByKey.set(keyOf(e.data), e);
  }
  const out: ReticleEvent[] = [];
  const enriched = new Map<ReticleEvent, ReticleEvent>();
  for (const e of events) {
    if (e.type === EventType.NET_DETAIL) {
      const match = requestByKey.get(keyOf(e.data));
      if (match === undefined) {
        out.push(e); // unmatched detail survives on its own
        continue;
      }
      const base = enriched.get(match) ?? match;
      const data = { ...base.data };
      if (data['headers'] === undefined && e.data['headers'] !== undefined) {
        data['headers'] = e.data['headers'];
      }
      if (data['resourceType'] === undefined && e.data['resourceType'] !== undefined) {
        data['resourceType'] = e.data['resourceType'];
      }
      // The ONLY field that overwrites rather than filling a gap. The in-page value is what the app
      // INTENDED to send; this is what actually went. When they disagree, the disagreement is the
      // finding — that is the whole reason for capturing it — so the authoritative one wins and the
      // divergence is flagged rather than silently resolved.
      const wireBody = e.data['requestBody'];
      if ('string' === typeof wireBody) {
        const pageBody = data['requestBody'];
        if ('string' === typeof pageBody && pageBody !== wireBody) {
          data['requestBodyDivergedFromPage'] = true;
        }
        data['requestBody'] = wireBody;
        // The caveat belongs to the body it describes, and this is the one field that REPLACES
        // rather than fills a gap. Carried over when the wire body was cut, deleted when it was not:
        // a stale `true` from the page capture would caveat a body that is now whole, and a missing
        // one would let a cut body read as complete.
        if (true === e.data['requestBodyTruncated']) data['requestBodyTruncated'] = true;
        else delete data['requestBodyTruncated'];
      }
      enriched.set(match, { ...base, data });
      continue; // the detail is absorbed into the request
    }
  }
  for (const e of events) {
    if (e.type === EventType.NET_DETAIL) continue; // handled above
    out.push(enriched.get(e) ?? e);
  }
  return out;
}
