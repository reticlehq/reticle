import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the transport so connect() never opens a real socket (mirrors iris-presenter.test.ts).
vi.mock('../transport/transport.js', () => {
  class FakeTransport {
    connect(): void {
      /* no-op */
    }
    close(): void {
      /* no-op */
    }
    sendEvent(): void {
      /* no-op */
    }
  }
  return { Transport: FakeTransport };
});

const { Iris } = await import('../iris.js');

const recorderRoot = (): Element | null =>
  document.querySelector('[data-iris-overlay] [data-iris-action="record"]');

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.querySelectorAll('[data-iris-overlay]').forEach((e) => e.remove());
});

describe('iris.ts recorder wiring', () => {
  it('recorder:true mounts the toolbar; disconnect tears it down', () => {
    const iris = new Iris();
    iris.connect({ recorder: true });
    expect(recorderRoot()).not.toBeNull();
    iris.disconnect();
    expect(recorderRoot()).toBeNull();
  });

  it('recorder omitted → no toolbar', () => {
    const iris = new Iris();
    iris.connect({});
    expect(recorderRoot()).toBeNull();
    iris.disconnect();
  });
});
