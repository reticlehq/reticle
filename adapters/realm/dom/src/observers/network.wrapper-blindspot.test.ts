import { describe, it, expect, afterEach, vi } from 'vitest';
import { BlindSpotKind, EventType } from '@reticlehq/core';
import { installNetwork } from './network.js';
import type { Teardown } from './types.js';

/**
 * If something wrapped `fetch` BEFORE us, we are not seeing the wire.
 *
 * Wrappers form a chain and the outermost runs first. Reticle records `init.body` when ITS wrapper
 * runs, so anything installed BELOW it — i.e. earlier — mutates the request AFTER we have recorded
 * and before it leaves. An axios/auth/analytics interceptor initialised before connect(), or a
 * polyfill, does exactly that. Our own 85-bug benchmark contains a bug of this shape that we miss and
 * a CDP-level tool catches.
 *
 * We cannot fix that from inside the page — there is no "patch last" primitive, and racing for
 * outermost is an arms race we would lose to whatever loads after us. What we CAN do is stop the
 * blind spot being silent. This is the same contract as the cross-origin-iframe sensor: say what we
 * cannot see, so a green verdict never implies we saw it.
 */
const teardowns: Teardown[] = [];
afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()?.();
  vi.unstubAllGlobals();
});

const collect = (): {
  emit: (t: EventType, d: Record<string, unknown>) => void;
  events: { type: EventType; data: Record<string, unknown> }[];
} => {
  const events: { type: EventType; data: Record<string, unknown> }[] = [];
  return { emit: (type, data) => events.push({ type, data }), events };
};

const blindSpots = (events: { type: EventType; data: Record<string, unknown> }[]) =>
  events.filter((e) => e.type === EventType.BLIND_SPOT);

describe('a fetch wrapper installed before us is declared, not hidden', () => {
  it('reports a blind spot when fetch is already patched at install', () => {
    // Someone else's wrapper — a plain function, not native code.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response()));

    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, {}));

    const spot = blindSpots(events).find((e) => e.data['kind'] === BlindSpotKind.WRAPPED_NETWORK);
    expect(spot).toBeDefined();
    expect(spot?.data['count']).toBe(1);
  });

  it('stays silent when fetch is the platform\'s own — silence must keep meaning "we see the wire"', () => {
    // jsdom implements fetch in JavaScript, so it reads as wrapped and would (correctly) trip the
    // sensor. Stub a native-looking one to exercise the negative case, which is the real contract:
    // on a browser with an untouched fetch we must not cry wolf.
    // A BOUND function reports "[native code]", which is the only way to synthesise a native-looking
    // fetch in a test. That is not incidental — it is the heuristic's known hole, pinned below.
    const native = (() => Promise.resolve(new Response())).bind(null) as unknown as typeof fetch;
    vi.stubGlobal('fetch', native);

    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, {}));
    expect(
      blindSpots(events).filter((e) => e.data['kind'] === BlindSpotKind.WRAPPED_NETWORK),
    ).toHaveLength(0);
  });

  /**
   * A polyfilled fetch IS an unobserved layer below us, so reporting it is correct rather than noise.
   * Recorded explicitly because it is the case most likely to be mistaken for a false positive by
   * someone triaging the signal — and because jsdom itself is one, which is how it was found.
   */
  it('reports a POLYFILLED fetch too — a polyfill is a layer we cannot see through', () => {
    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, {})); // jsdom's fetch is a JS implementation
    expect(
      blindSpots(events).filter((e) => e.data['kind'] === BlindSpotKind.WRAPPED_NETWORK).length,
    ).toBeGreaterThan(0);
  });

  it('does not fire for OUR OWN wrapper on a second install', () => {
    const first = collect();
    teardowns.push(installNetwork(first.emit, {}));
    const second = collect();
    teardowns.push(installNetwork(second.emit, {}));
    // The second install sees a patched fetch — but it is ours, and reporting it would make every
    // re-install look like an app problem.
    expect(
      blindSpots(second.events).filter((e) => e.data['kind'] === BlindSpotKind.WRAPPED_NETWORK),
    ).toHaveLength(0);
  });
});

/**
 * The heuristic's known hole, pinned so it is a documented limit rather than a surprise.
 *
 * `Function.prototype.toString` on a BOUND function reports "[native code]", so a wrapper installed as
 * `window.fetch = myWrapper.bind(x)` is indistinguishable from the real thing. Nothing in the platform
 * distinguishes them, so this is not fixable — but a limit that a test states is one someone can
 * reason about, and it fails safe: we under-report rather than cry wolf.
 */
describe('known limit of the native-fetch heuristic', () => {
  it('a BOUND wrapper evades detection, and that is recorded rather than hidden', () => {
    const foreign = ((): Promise<Response> => Promise.resolve(new Response())).bind(null);
    vi.stubGlobal('fetch', foreign);

    const { emit, events } = collect();
    teardowns.push(installNetwork(emit, {}));
    // Documents the miss. If the platform ever gives a better signal, this goes red and should.
    expect(
      blindSpots(events).filter((e) => e.data['kind'] === BlindSpotKind.WRAPPED_NETWORK),
    ).toHaveLength(0);
  });
});
