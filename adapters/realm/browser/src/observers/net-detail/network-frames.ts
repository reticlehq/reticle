import { RETICLE_WS_PATH } from '@reticlehq/core/page';
import { projectBody } from './network-body.js';

/** The byte size of a binary frame (ArrayBuffer / Blob / typed-array view), or undefined if unknown. */
function binaryFrameBytes(data: unknown): number | undefined {
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.size;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  return undefined;
}

/** Project one SSE/WebSocket frame: byte size + shape; the (capped, redacted) payload only when body
 * capture is on and it is a string frame. Binary frames report their byte size, not just a bare type. */
export function frameFields(data: unknown, captureBodies: boolean): Record<string, unknown> {
  if (typeof data !== 'string') {
    const bytes = binaryFrameBytes(data);
    return bytes === undefined
      ? { frameType: typeof data }
      : { frameType: 'binary', frameBytes: bytes };
  }
  const out: Record<string, unknown> = { frameBytes: data.length };
  if (captureBodies) {
    const { body, truncated } = projectBody(data, 'application/json');
    out['frame'] = body;
    if (truncated) {
      out['frameTruncated'] = true;
    }
  }
  return out;
}

/**
 * True for Reticle's OWN bridge connection, which must never be instrumented.
 *
 * The transport resolves `WebSocket` at call time, so a reconnect after instrumentation constructs a
 * PATCHED socket. From then on emitting an event calls transport.send -> the patched send emits a
 * NET_STREAM event -> which calls transport.send again, until the stack blows and the page is dead.
 * Keyed on the bridge PATH rather than the host: an app's own socket on the same origin must still be
 * observed, otherwise this guard would blind the stream category it exists to protect.
 */
export function isBridgeSocket(url: string): boolean {
  try {
    return new URL(url, location.href).pathname === RETICLE_WS_PATH;
  } catch {
    return url.includes(RETICLE_WS_PATH);
  }
}
