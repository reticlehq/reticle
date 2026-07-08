import { EventType, REDACTED_VALUE } from '@reticlehq/protocol';
import { isSensitiveKey } from '../security/serialization.js';
import type { Emit, Teardown } from './types.js';

/**
 * Redact credential-bearing query params (`?access_token=…`, signed-URL keys, magic-link tokens) so
 * they don't leak into the agent transcript / flow / run artifacts. Only the query string is rewritten
 * — the path (relative or absolute) and any hash are preserved — and only when something actually
 * matched, so non-sensitive URLs pass through byte-for-byte. Uses the shared `isSensitiveKey` regex.
 */
export function redactUrl(raw: string): string {
  const queryStart = raw.indexOf('?');
  if (queryStart === -1) return raw;
  const base = raw.slice(0, queryStart);
  const rest = raw.slice(queryStart + 1);
  const hashStart = rest.indexOf('#');
  const query = hashStart === -1 ? rest : rest.slice(0, hashStart);
  const hash = hashStart === -1 ? '' : rest.slice(hashStart);
  const params = new URLSearchParams(query);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (isSensitiveKey(key)) {
      params.set(key, REDACTED_VALUE);
      changed = true;
    }
  }
  return changed ? `${base}?${params.toString()}${hash}` : raw;
}

interface XhrMeta {
  id: string;
  method: string;
  url: string;
  start: number;
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
