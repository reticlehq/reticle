import { redactUrl } from './network-redact.js';

/**
 * Document-initiated subresource observation.
 *
 * fetch/XHR patches never see requests the DOCUMENT makes on its own: `<link rel=icon>`,
 * `<link rel=manifest>`, stylesheets, `<img src>`, `<script src>`. Those are exactly the loads a
 * branding change touches, so a `{net}` predicate over them used to return `assertion_failed`
 * ("your change is broken") when the truthful answer was "not observable" — and an agent trusting
 * that verdict goes and "fixes" working code.
 *
 * `performance.getEntriesByType('resource')` reports these with no CDP and no patching: URL (name),
 * initiator type (`link`, `css`, `img`, `script`, …), duration, transfer size. The known limitation
 * is the status code — resource timing does not expose one directly (`responseStatus` exists only
 * in newer Chromium). Entries carry `status` ONLY when it could be read; predicates asserting a
 * status over unreadable data are handled at the evaluation seam, which downgrades rather than
 * guesses.
 *
 * Deduplication matters: a fetch/XHR-initiated request ALSO lands in resource timing. Every entry
 * is checked against the URLs the patched transports already reported this page, and only genuinely
 * document-initiated loads survive.
 */

/** Resource-timing initiator types that mean "the document itself asked", not a patched transport. */
const DOCUMENT_INITIATORS = new Set(['link', 'css', 'img', 'script', 'manifest', 'other']);

/** Cap per call — a pathological page must not blow the event budget. */
const MAX_SUBRESOURCE_EVENTS = 200;

export interface SubresourceObservation {
  url: string;
  method: string;
  status?: number;
  ok?: boolean;
  durationMs: number;
  transferSize?: number;
  initiatorType: string;
}

export function collectSubresources(
  seenUrls: ReadonlySet<string>,
  nowMs: number,
  sinceMs: number,
): SubresourceObservation[] {
  const out: SubresourceObservation[] = [];
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (const entry of entries) {
      const initiatorType = entry.initiatorType || 'other';
      // fetch/XHR already have richer records from their own patches.
      if (!DOCUMENT_INITIATORS.has(initiatorType)) continue;
      const raw = entry.name;
      if (seenUrls.has(raw)) continue;
      const startMs = nowMs - entry.duration;
      if (startMs < sinceMs) continue;
      const obs: SubresourceObservation = {
        url: redactUrl(raw),
        method: 'GET',
        durationMs: Math.round(entry.duration),
        initiatorType,
        ...(entry.transferSize > 0 ? { transferSize: entry.transferSize } : {}),
      };
      // responseStatus is Chromium-only and may be 0 when unreadable. Present ONLY when it says
      // something real, so the wire never carries a guessed status.
      const rs = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus;
      if ('number' === typeof rs && rs > 0) {
        obs.status = rs;
        obs.ok = rs >= 200 && rs < 400;
      }
      out.push(obs);
    }
  } catch {
    // No resource-timing support / security error: report nothing, honestly.
    return [];
  }
  return out.slice(0, MAX_SUBRESOURCE_EVENTS);
}
