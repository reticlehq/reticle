import { EventType, REDACTED_VALUE } from '@reticlehq/core';
import { isSensitiveKey } from '../security/serialization.js';
import type { Emit, Teardown } from './types.js';

/** A path segment name that is typically followed by a single-use secret token in the NEXT segment. */
const SENSITIVE_PATH_SEGMENT =
  /^(reset|verify|verification|confirm|activate|invite|magic|magiclink|token|key|oauth|unsubscribe|password)$/i;
/** Only mask a following segment that looks token-like — short ids/words (`reset/form`) are left alone. */
const PATH_TOKEN_MIN_LENGTH = 12;

/**
 * Redact credential-bearing values so they don't leak into the agent transcript / flow / run
 * artifacts: query params (`?access_token=…`, signed-URL keys) via the shared `isSensitiveKey` regex,
 * AND path-embedded tokens (`/reset/<token>`, `/invite/<token>`) that live in the path, not the query.
 * The hash is preserved and the URL is returned byte-for-byte when nothing matched.
 */
export function redactUrl(raw: string): string {
  const hashStart = raw.indexOf('#');
  const hash = hashStart === -1 ? '' : raw.slice(hashStart);
  const beforeHash = hashStart === -1 ? raw : raw.slice(0, hashStart);
  const queryStart = beforeHash.indexOf('?');
  const pathPart = queryStart === -1 ? beforeHash : beforeHash.slice(0, queryStart);
  const query = queryStart === -1 ? '' : beforeHash.slice(queryStart + 1);

  let changed = false;

  let newQuery = query;
  if (query !== '') {
    const params = new URLSearchParams(query);
    for (const key of [...params.keys()]) {
      if (isSensitiveKey(key)) {
        params.set(key, REDACTED_VALUE);
        changed = true;
      }
    }
    newQuery = params.toString();
  }

  const segments = pathPart.split('/');
  for (let i = 0; i + 1 < segments.length; i++) {
    const name = segments[i];
    const next = segments[i + 1];
    if (
      name !== undefined &&
      next !== undefined &&
      next.length >= PATH_TOKEN_MIN_LENGTH &&
      SENSITIVE_PATH_SEGMENT.test(name)
    ) {
      segments[i + 1] = REDACTED_VALUE;
      changed = true;
    }
  }

  if (!changed) return raw;
  const queryOut = queryStart === -1 ? '' : `?${newQuery}`;
  return `${segments.join('/')}${queryOut}${hash}`;
}

interface XhrMeta {
  id: string;
  method: string;
  url: string;
  start: number;
}

/**
 * Response metadata that needs no body capture: HTTP status text, content-type, and byte size (from
 * content-length when the server sent it). Lets an agent tell an HTML error page served as 200 from
 * real JSON, and spot empty/oversized responses. Fields are omitted when absent so a clean call stays
 * token-flat.
 */
function netResponseMeta(
  statusText: string,
  contentType: string | null,
  contentLength: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (statusText !== '') out['statusText'] = statusText;
  if (contentType !== null && contentType !== '') out['contentType'] = contentType;
  const size = contentLength !== null ? Number.parseInt(contentLength, 10) : Number.NaN;
  if (Number.isFinite(size)) out['responseSize'] = size;
  return out;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

/** Patch fetch + XMLHttpRequest to emit net.request events. Fully reversible. */
export function installNetwork(emit: Emit): Teardown {
  // Keep the true original for teardown identity, plus a window-bound copy to invoke
  // (fetch throws "Illegal invocation" if called with the wrong `this`).
  const origFetch = window.fetch;
  const callFetch = origFetch.bind(window);

  // Correlation id so a NET_PENDING (emitted at request START) can be matched to its
  // NET_REQUEST completion. A request that never completes leaves an unmatched NET_PENDING —
  // that is how a hung/in-flight request becomes observable (it never resolves, so the old
  // completion-only emit saw nothing).
  let seq = 0;
  const nextId = (): string => `n${++seq}`;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const id = nextId();
    const start = performance.now();
    const method = methodOf(input, init);
    const url = redactUrl(urlOf(input));
    emit(EventType.NET_PENDING, { id, method, url, initiator: 'fetch' });
    try {
      const res = await callFetch(input, init);
      emit(EventType.NET_REQUEST, {
        id,
        method,
        url,
        status: res.status,
        ok: res.ok,
        durationMs: Math.round(performance.now() - start),
        initiator: 'fetch',
        ...netResponseMeta(
          res.statusText,
          res.headers.get('content-type'),
          res.headers.get('content-length'),
        ),
      });
      return res;
    } catch (error) {
      emit(EventType.NET_REQUEST, {
        id,
        method,
        url,
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - start),
        initiator: 'fetch',
      });
      throw error;
    }
  };

  const meta = new WeakMap<XMLHttpRequest, XhrMeta>();
  const proto = XMLHttpRequest.prototype;
  /* eslint-disable @typescript-eslint/unbound-method -- captured to re-invoke via .call(this) */
  const origOpen = proto.open;
  const origSend = proto.send;
  /* eslint-enable @typescript-eslint/unbound-method */
  const callOpen = origOpen as (this: XMLHttpRequest, ...args: unknown[]) => void;

  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    meta.set(this, {
      id: nextId(),
      method: method.toUpperCase(),
      url: redactUrl(String(url)),
      start: 0,
    });
    callOpen.call(this, method, url, ...rest);
  };

  proto.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const m = meta.get(this);
    if (m !== undefined) {
      m.start = performance.now();
      emit(EventType.NET_PENDING, { id: m.id, method: m.method, url: m.url, initiator: 'xhr' });
      this.addEventListener('loadend', () => {
        emit(EventType.NET_REQUEST, {
          id: m.id,
          method: m.method,
          url: m.url,
          status: this.status,
          ok: this.status >= 200 && this.status < 400,
          durationMs: Math.round(performance.now() - m.start),
          initiator: 'xhr',
          ...netResponseMeta(
            this.statusText,
            this.getResponseHeader('content-type'),
            this.getResponseHeader('content-length'),
          ),
        });
      });
    }
    origSend.call(this, body ?? null);
  };

  return () => {
    window.fetch = origFetch;
    proto.open = origOpen;
    proto.send = origSend;
  };
}
