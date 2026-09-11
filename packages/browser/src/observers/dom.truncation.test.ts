import { describe, it, expect } from 'vitest';
import { EventType, TruncationChannel } from '@reticlehq/core';
import { installDom } from './dom.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('installDom truncation honesty', () => {
  it('emits TRUNCATED{channel:dom} when a mutation batch exceeds the per-batch cap', async () => {
    document.body.innerHTML = '';
    const events: Captured[] = [];
    const teardown = installDom((type, data) => events.push({ type, data }));

    // 60 meaningful nodes in one batch — over the 40/batch cap, so ~20 are dropped.
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 60; i += 1) {
      const button = document.createElement('button');
      button.textContent = `Btn ${String(i)}`;
      frag.appendChild(button);
    }
    document.body.appendChild(frag);
    await flushMutations();
    teardown();

    const truncated = events.find((e) => e.type === EventType.TRUNCATED);
    expect(truncated).toBeDefined();
    expect(truncated?.data['channel']).toBe(TruncationChannel.DOM);
    expect(truncated?.data['dropped']).toBeGreaterThan(0);
  });

  it('does not emit TRUNCATED for a small batch under the cap', async () => {
    document.body.innerHTML = '';
    const events: Captured[] = [];
    const teardown = installDom((type, data) => events.push({ type, data }));

    const button = document.createElement('button');
    button.textContent = 'Solo';
    document.body.appendChild(button);
    await flushMutations();
    teardown();

    expect(events.some((e) => e.type === EventType.TRUNCATED)).toBe(false);
  });
});
