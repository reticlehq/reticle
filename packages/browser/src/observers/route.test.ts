import { describe, it, expect, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installRoute } from './route.js';
import type { Emit, Teardown } from './types.js';

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function collect(): { emit: Emit; events: Emitted[] } {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  return { emit, events };
}

describe('installRoute', () => {
  let teardown: Teardown | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('emits ROUTE_CHANGE on pushState to a new url', () => {
    const { emit, events } = collect();
    teardown = installRoute(emit);

    history.pushState({}, '', '/next');

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.ROUTE_CHANGE);
    expect(String(events[0]?.data.pathname)).toBe('/next');
  });

  it('emits ROUTE_CHANGE on a Back navigation after a pushState (stale-lastHref regression)', async () => {
    const { emit, events } = collect();
    history.replaceState({}, '', '/a');
    teardown = installRoute(emit);

    history.pushState({}, '', '/b'); // /a -> /b
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      history.back(); // back to /a
    });

    const backNav = events.find(
      (e) => String(e.data.from).endsWith('/b') && String(e.data.to).endsWith('/a'),
    );
    expect(backNav).toBeDefined();
  });

  it('restores the original history methods (identity) on teardown', () => {
    /* eslint-disable @typescript-eslint/unbound-method -- comparing method identity, not calling */
    const beforePush = history.pushState;
    const beforeReplace = history.replaceState;
    const t = installRoute(collect().emit);
    expect(history.pushState).not.toBe(beforePush);
    t();
    expect(history.pushState).toBe(beforePush);
    expect(history.replaceState).toBe(beforeReplace);
    /* eslint-enable @typescript-eslint/unbound-method */
  });
});
