import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventType } from '@syrin/iris-protocol';
import { installNetwork } from './network.js';
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

/** A minimal Response stand-in — jsdom does not always expose a usable global Response. */
function fakeResponse(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe('installNetwork (fetch)', () => {
  let teardown: Teardown | undefined;
  const origFetch = window.fetch;

  beforeEach(() => {
    // Ensure there is a fetch for the observer to wrap; each test overrides the behavior.
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(200)));
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    window.fetch = origFetch;
  });

  it('emits NET_REQUEST for a GET that resolves with a 500 (the regression that prompted this test)', async () => {
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(500)));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    const res = await window.fetch('http://localhost:8787/api/broken/500');

    expect(res.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.NET_REQUEST);
    expect(events[0]?.data).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8787/api/broken/500',
      status: 500,
      ok: false,
      initiator: 'fetch',
    });
  });

  it('captures the method from init for a POST', async () => {
    window.fetch = vi.fn(() => Promise.resolve(fakeResponse(200)));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    await window.fetch('http://localhost:8787/api/login', { method: 'POST' });

    expect(events[0]?.data).toMatchObject({ method: 'POST', status: 200, ok: true });
  });

  it('emits a NET_REQUEST with status 0 and rethrows when the fetch rejects', async () => {
    const boom = new Error('network down');
    window.fetch = vi.fn(() => Promise.reject(boom));
    const { emit, events } = collect();
    teardown = installNetwork(emit);

    await expect(window.fetch('http://localhost:8787/api/x')).rejects.toBe(boom);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ status: 0, ok: false, error: 'network down' });
  });

  it('restores the original fetch on teardown', () => {
    const before = window.fetch;
    const t = installNetwork(collect().emit);
    expect(window.fetch).not.toBe(before);
    t();
    expect(window.fetch).toBe(before);
  });
});
