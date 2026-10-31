import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the transport so connect never opens a real socket (mirrors reticle-presenter.test.ts).
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

const { Reticle } = await import('@/reticle.js');

const recorderRoot = (): Element | null =>
  document.querySelector('[data-reticle-overlay] [data-reticle-action="record"]');

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.querySelectorAll('[data-reticle-overlay]').forEach((e) => e.remove());
});

describe('reticle.ts recorder wiring', () => {
  // The recorder is loaded on demand, so it mounts just after connect.
  it('recorder:true mounts the toolbar; disconnect tears it down', async () => {
    const reticle = new Reticle();
    reticle.connect({ recorder: true });
    await vi.waitFor(() => {
      expect(recorderRoot()).not.toBeNull();
    });
    reticle.disconnect();
    expect(recorderRoot()).toBeNull();
  });

  it('a page that disconnects before the recorder arrives never mounts it', async () => {
    const reticle = new Reticle();
    reticle.connect({ recorder: true });
    reticle.disconnect();
    await import('./recorder.js');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorderRoot()).toBeNull();
  });

  it('recorder omitted → no toolbar', () => {
    const reticle = new Reticle();
    reticle.connect({});
    expect(recorderRoot()).toBeNull();
    reticle.disconnect();
  });
});
