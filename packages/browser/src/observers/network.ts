import { EventType } from '@syrin/iris-protocol';
import type { Emit, Teardown } from './types.js';

interface XhrMeta {
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
  const origFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const start = performance.now();
    const method = methodOf(input, init);
    const url = urlOf(input);
    try {
      const res = await origFetch(input, init);
      emit(EventType.NET_REQUEST, {
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
    meta.set(this, { method: method.toUpperCase(), url: String(url), start: 0 });
    callOpen.call(this, method, url, ...rest);
  };

  proto.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const m = meta.get(this);
    if (m !== undefined) {
      m.start = performance.now();
      this.addEventListener('loadend', () => {
        emit(EventType.NET_REQUEST, {
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
