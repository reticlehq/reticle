import { describe, it, expect } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installDom } from './dom.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('installDom old-value capture (diffs, not readings)', () => {
  it('reports the old and new value on a watched attribute change', async () => {
    document.body.innerHTML = '<button class="idle">Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const events: Captured[] = [];
    const teardown = installDom((type, data) => events.push({ type, data }));

    button.setAttribute('class', 'busy');
    await flushMutations();
    teardown();

    const attr = events.find((e) => e.type === EventType.DOM_ATTR);
    expect(attr?.data['attr']).toBe('class');
    expect(attr?.data['value']).toBe('busy');
    expect(attr?.data['old']).toBe('idle');
  });

  it('caps a very long attribute value', async () => {
    document.body.innerHTML = '<div></div>';
    const div = document.querySelector('div') as HTMLDivElement;
    const events: Captured[] = [];
    const teardown = installDom((type, data) => events.push({ type, data }));

    div.setAttribute('style', `width:${'9'.repeat(500)}px`);
    await flushMutations();
    teardown();

    const attr = events.find((e) => e.type === EventType.DOM_ATTR);
    expect((attr?.data['value'] as string).length).toBeLessThan(200);
    expect(attr?.data['value']).toContain('…');
  });
});
