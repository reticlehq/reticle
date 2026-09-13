import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { hasUnreadWriteOutcome, unreadWriteLabels } from './unread-outcome.js';

const call = (data: Record<string, unknown>): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: 10,
    data: { url: '/api/x', ...data },
  }) as unknown as ReticleEvent;

describe('a write whose outcome went unread', () => {
  it('reports a 2xx write with a payload that exists and was not recorded', () => {
    expect(hasUnreadWriteOutcome([call({ method: 'POST', status: 200, responseSize: 412 })])).toBe(
      true,
    );
  });

  it('stays silent once the body IS recorded — findBodyFailures judges it instead', () => {
    expect(
      hasUnreadWriteOutcome([
        call({ method: 'POST', status: 200, responseSize: 412, responseBody: '{"ok":true}' }),
      ]),
    ).toBe(false);
  });

  it('stays silent for a GET — the DOM already witnesses what a read returned', () => {
    expect(hasUnreadWriteOutcome([call({ method: 'GET', status: 200, responseSize: 9000 })])).toBe(
      false,
    );
  });

  it('stays silent for a genuinely empty response', () => {
    expect(hasUnreadWriteOutcome([call({ method: 'POST', status: 204, responseSize: 0 })])).toBe(
      false,
    );
  });

  it('stays silent when the size is unknown — "empty" and "unseen" must not be guessed apart', () => {
    expect(hasUnreadWriteOutcome([call({ method: 'POST', status: 200 })])).toBe(false);
  });

  it('stays silent for a failed write — the status already says so', () => {
    expect(hasUnreadWriteOutcome([call({ method: 'POST', status: 500, responseSize: 120 })])).toBe(
      false,
    );
  });
});

/**
 * The dev toolchain is not the app under test.
 *
 * Next's dev overlay resolves a source map with `POST /__nextjs_original-stack-frames` the moment
 * the app logs one React warning, and it answers 200 with a JSON body nobody captures. Read as the
 * app's own write, that turned every verdict in a Next dev app into `unknown` — a verdict decided by
 * a channel the caller never asked about, on traffic the app did not make. `findContradictions`
 * already splits this traffic out; this rule was reading the unsplit window.
 */
describe('dev-toolchain traffic is not the app', () => {
  it('stays silent for the Next dev overlay resolving a source map', () => {
    expect(
      hasUnreadWriteOutcome([
        call({
          method: 'POST',
          url: '/__nextjs_original-stack-frames',
          status: 200,
          responseSize: 812,
        }),
      ]),
    ).toBe(false);
  });

  // Negative control: the shipments false green this rule exists for. A real write whose body went
  // unread must still be reported, in the same window as the toolchain's own traffic.
  it("still reports the APP's write in the same window", () => {
    expect(
      hasUnreadWriteOutcome([
        call({
          method: 'POST',
          url: '/__nextjs_original-stack-frames',
          status: 200,
          responseSize: 812,
        }),
        call({ method: 'POST', url: '/api/bulk-hold', status: 200, responseSize: 412 }),
      ]),
    ).toBe(true);
  });
});

/**
 * A caveat an agent cannot locate is a caveat it learns to ignore. The reason said "a write returned
 * 2xx with a response body that was never recorded" and named no write, so a reporter looking at a
 * desktop app spent the investigation guessing which call it meant.
 */
describe('the deciding write is named', () => {
  it('names method and url', () => {
    expect(
      unreadWriteLabels([
        call({ method: 'POST', url: '/api/bulk-hold', status: 200, responseSize: 412 }),
      ]),
    ).toEqual(['POST /api/bulk-hold']);
  });

  it('is empty when nothing went unread — the field is its own warning', () => {
    expect(unreadWriteLabels([call({ method: 'GET', status: 200, responseSize: 9000 })])).toEqual(
      [],
    );
  });
});

describe('IPC is not HTTP', () => {
  // Measured: forwarding `responseSize` for IPC made a healthy `todos:add` on a default Electron
  // config return `unknown`. Every ordinary desktop action would have carried that caveat — the
  // cry-wolf failure that teaches agents to ignore the field.
  it('stays silent for an IPC call whose payload went unread', () => {
    expect(hasUnreadWriteOutcome([call({ method: 'ipc', status: 200, responseSize: 129 })])).toBe(
      false,
    );
  });

  it('still reports an HTTP write in the same window', () => {
    expect(
      hasUnreadWriteOutcome([
        call({ method: 'ipc', status: 200, responseSize: 129 }),
        call({ method: 'POST', status: 200, responseSize: 412 }),
      ]),
    ).toBe(true);
  });
});
