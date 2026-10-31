import { EventType, NetInitiator, urlForMatch, type ReticleEvent } from '@reticlehq/core';

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

/** True when a response is a file the server sent to be saved, not shown. */
function isAttachment(headers: unknown): boolean {
  if ('object' !== typeof headers || null === headers) {
    return false;
  }
  const disposition = (headers as Record<string, unknown>)['content-disposition'];
  return 'string' === typeof disposition && /^\s*attachment\b/i.test(disposition);
}

/**
 * A wire detail for a server-sent download, as the request it was; undefined for any other detail.
 * Its duration was not measured (the page never timed it), so it carries 0.
 */
function downloadRequest(e: ReticleEvent): ReticleEvent | undefined {
  if (!isAttachment(e.data['headers'])) {
    return undefined;
  }
  const status = 'number' === typeof e.data['status'] ? e.data['status'] : 0;
  return {
    ...e,
    type: EventType.NET_REQUEST,
    data: {
      ...e.data,
      id: `download:${String(e.t)}:${urlForMatch(e.data)}`,
      ok: 200 <= status && status < 400,
      durationMs: 0,
      initiator: NetInitiator.DOWNLOAD,
    },
  };
}

/**
 * Record every server-sent download the driven browser saw, and that the page never recorded, as a
 * request — and change nothing else. A `net` check with no body clause runs on events that the full
 * merge below never touches, so without this a plain status check on a working export missed.
 */
export function withDownloadRequests(events: readonly ReticleEvent[]): ReticleEvent[] {
  const recorded = new Set(
    events.filter((e) => e.type === EventType.NET_REQUEST).map((e) => keyOf(e.data)),
  );
  return events.map((e) =>
    e.type === EventType.NET_DETAIL && !recorded.has(keyOf(e.data)) ? (downloadRequest(e) ?? e) : e,
  );
}

/**
 * Fold wire details by method+url, and SDK response bodies by request id plus method+url.
 * SDK body details finish background capture without adding another request to counts or settle.
 * Keep unmatched details rather than attaching them to another request. Pure over the event list.
 */
export function mergeNetworkDetail(events: readonly ReticleEvent[]): ReticleEvent[] {
  const requestByKey = new Map<string, ReticleEvent>();
  const requestById = new Map<string, ReticleEvent>();
  for (const e of events) {
    if (e.type !== EventType.NET_REQUEST) {
      continue;
    }
    requestByKey.set(keyOf(e.data), e);
    if ('string' === typeof e.data['id']) {
      requestById.set(e.data['id'], e);
    }
  }
  const out: ReticleEvent[] = [];
  const enriched = new Map<ReticleEvent, ReticleEvent>();
  for (const e of events) {
    if (e.type === EventType.NET_DETAIL || e.type === EventType.NET_RESPONSE_BODY) {
      const sdkBody = e.type === EventType.NET_RESPONSE_BODY;
      const responseBody = e.data['responseBody'];
      const id = e.data['id'];
      // SDK body details carry the page's request id. URL alone mixes concurrent streams at one endpoint.
      let match: ReticleEvent | undefined;
      if (sdkBody) {
        if ('string' === typeof id) {
          match = requestById.get(id);
        }
      } else {
        match = requestByKey.get(keyOf(e.data));
      }
      if (match === undefined || keyOf(match.data) !== keyOf(e.data)) {
        // A server-sent download has no in-page request to merge onto: it left the page as a
        // navigation. The driven browser saw it, so it is recorded as the request it was. Any other
        // unmatched detail survives on its own, as before.
        out.push(sdkBody ? e : (downloadRequest(e) ?? e));
        continue;
      }
      const base = enriched.get(match) ?? match;
      const data = { ...base.data };
      if (sdkBody && 'string' === typeof responseBody) {
        data['responseBody'] = responseBody;
        if (true === e.data['responseBodyTruncated']) {
          data['responseBodyTruncated'] = true;
        } else {
          delete data['responseBodyTruncated'];
        }
        delete data['responseBodyReason'];
      }
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
        if (true === e.data['requestBodyTruncated']) {
          data['requestBodyTruncated'] = true;
        } else {
          delete data['requestBodyTruncated'];
        }
      }
      enriched.set(match, { ...base, data });
      continue; // the detail is absorbed into the request
    }
  }
  for (const e of events) {
    if (e.type === EventType.NET_DETAIL || e.type === EventType.NET_RESPONSE_BODY) {
      continue;
    } // handled above
    out.push(enriched.get(e) ?? e);
  }
  return out;
}
