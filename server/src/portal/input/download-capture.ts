import { buildNetworkDetail, type NetworkDetail } from './network-detail.js';
import { drivenRedactionPolicy } from './driven-redaction.js';

/**
 * Capture a file the server sends as a download, on a page Reticle drives.
 *
 * A click that becomes a download leaves the page as a navigation the browser turns into a file.
 * Measured on Chromium, nothing the page can see records it: no page `request`/`response` event, no
 * CDP `Network.responseReceived` on the page target, and a Playwright route does not intercept it.
 * So a `net` check on a working export missed. CDP request interception at the response stage does
 * see it, with the status and headers, so this listens there.
 *
 * Document responses only, and every paused response is let through at once: the capture must never
 * change or delay what the page receives. Chromium only; a browser without the Fetch domain gets no
 * capture rather than an error.
 */

const DOCUMENT_RESPONSES = { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] };

/** The part of a CDP session this needs, kept structural so it can be tested with a fake. */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (event: unknown) => void): void;
}

interface PausedResponse {
  requestId?: unknown;
  request?: { url?: unknown; method?: unknown };
  responseStatusCode?: unknown;
  responseHeaders?: unknown;
}

function headersOf(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!Array.isArray(raw)) {
    return headers;
  }
  for (const entry of raw) {
    const { name, value } = (entry ?? {}) as { name?: unknown; value?: unknown };
    if ('string' === typeof name && 'string' === typeof value) {
      headers[name.toLowerCase()] = value;
    }
  }
  return headers;
}

function isAttachment(headers: Record<string, string>): boolean {
  return /^\s*attachment\b/i.test(headers['content-disposition'] ?? '');
}

export async function attachDownloadCapture(
  cdp: CdpLike,
  emit: (detail: NetworkDetail) => void,
  pageUrl: () => string,
): Promise<void> {
  cdp.on('Fetch.requestPaused', (event) => {
    const paused = (event ?? {}) as PausedResponse;
    try {
      const headers = headersOf(paused.responseHeaders);
      const url = paused.request?.url;
      const status = paused.responseStatusCode;
      if (isAttachment(headers) && 'string' === typeof url && 'number' === typeof status) {
        const method = paused.request?.method;
        emit(
          buildNetworkDetail(
            {
              url,
              ...('string' === typeof method ? { method } : {}),
              status,
              headers,
              resourceType: 'document',
              pageUrl: pageUrl(),
            },
            drivenRedactionPolicy(),
          ),
        );
      }
    } catch {
      // Recording is best-effort; letting the response through below is not.
    }
    if ('string' === typeof paused.requestId) {
      void cdp
        .send('Fetch.continueRequest', { requestId: paused.requestId })
        .catch(() => undefined);
    }
  });
  await cdp.send('Fetch.enable', DOCUMENT_RESPONSES);
}
