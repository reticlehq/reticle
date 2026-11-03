/**
 * The browser's own record of each load, read from `resource` performance entries.
 *
 * One question: which loads did the patched transports not see?
 */
import { EventType } from '@reticlehq/core';
import { netUrlFields } from './network-redact.js';

type EmitNet = (type: EventType, data: Record<string, unknown>) => void;

/** At most this many records of each kind, so a page that loads thousands of images is not a flood. */
const RESOURCE_CAP = 200;

/**
 * The URL as resource timing names it: absolute. A patched call can name `/api/ping`, and its
 * entry names `https://app.test/api/ping`; the two must compare equal.
 */
export function absoluteUrl(raw: string): string {
  try {
    return new URL(raw, location.href).href;
  } catch {
    return raw;
  }
}

/** The status fields, only when the entry carries a readable one. 0 means "not readable". */
function statusFields(entry: PerformanceResourceTiming, withOk: boolean): Record<string, unknown> {
  const status = entry.responseStatus ?? 0;
  if (status <= 0) {
    return {};
  }
  return withOk ? { status, ok: status >= 200 && status < 400 } : { status };
}

export interface ResourceTimingInput {
  emit: EmitNet;
  /** `performance.now()` when the patches were installed. */
  installedAt: number;
  nextId: () => string;
  /** URLs some record already reported, as the patched transports wrote them. */
  reportedNetUrls: Set<string>;
  /** Absolute URLs a patched transport saw START. Filled before the request leaves. */
  patchedNetUrls: ReadonlySet<string>;
}

/**
 * Report the loads the patched transports never see. Returns the observer, or `undefined` where
 * the page has no `PerformanceObserver`.
 *
 * Document-initiated subresources (link/css/img/script/manifest): without this a `{net}` predicate
 * over a favicon reads `assertion_failed` when the truthful answer is "not observable". Status is
 * emitted ONLY when readable; entries carry one only on newer Chromium.
 *
 * A fetch or XHR entry from before the patch has no other record, so it is reported as a GET
 * `net.request`. A fetch or XHR entry from after the patch that no patched transport saw went
 * through a `fetch` the app saved before connect(). It is reported as `net.unpatched`, not as a
 * request: it has no method, and a second record for a call would raise a false duplicate.
 *
 * Order of arrival: a patched transport adds its URL to `patchedNetUrls` synchronously, before the
 * request leaves. The browser writes the entry only after the response ends, and delivers it in a
 * later task. So the entry for a patched call always finds its URL already in the set.
 *
 * ponytail: `patchedNetUrls` is per session, not per call. A URL the patch saw once never gets a
 * marker again, so a later unpatched call to it still reads as a plain miss. Match by time if that
 * case is seen.
 */
export function observeResourceTiming(input: ResourceTimingInput): PerformanceObserver | undefined {
  const { emit, installedAt, nextId, reportedNetUrls, patchedNetUrls } = input;
  if ('undefined' === typeof PerformanceObserver) {
    return undefined;
  }
  let subresourceEvents = 0;
  let unpatchedEvents = 0;
  const onEntry = (entry: PerformanceResourceTiming): void => {
    const type = entry.initiatorType || 'other';
    const rawUrl = entry.name;
    const patched = 'fetch' === type || 'xmlhttprequest' === type;
    if (patched && entry.startTime >= installedAt) {
      if (patchedNetUrls.has(absoluteUrl(rawUrl)) || unpatchedEvents >= RESOURCE_CAP) {
        return;
      }
      unpatchedEvents += 1;
      emit(EventType.NET_UNPATCHED, {
        ...netUrlFields(rawUrl),
        initiator: type,
        // A hint only: 0 cross-origin without Timing-Allow-Origin, so it is left out then.
        ...statusFields(entry, false),
      });
      return;
    }
    if (reportedNetUrls.has(rawUrl) || subresourceEvents >= RESOURCE_CAP) {
      return;
    }
    reportedNetUrls.add(rawUrl);
    subresourceEvents += 1;
    emit(EventType.NET_REQUEST, {
      id: nextId(),
      method: 'GET',
      ...netUrlFields(rawUrl),
      durationMs: Math.round(entry.duration),
      initiator: type,
      ...(entry.transferSize > 0 ? { transferSize: entry.transferSize } : {}),
      // Omitted when unreadable, so the wire never carries a guessed status. The server reads its
      // absence as unknown.
      ...statusFields(entry, true),
    });
  };
  try {
    const observer = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        onEntry(raw as PerformanceResourceTiming);
      }
    });
    observer.observe({ type: 'resource', buffered: true });
    return observer;
  } catch {
    // No observer support: these loads stay unobserved, stated rather than guessed.
    return undefined;
  }
}
