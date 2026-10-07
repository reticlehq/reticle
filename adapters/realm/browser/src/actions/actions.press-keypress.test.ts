import { beforeEach, describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

let el: HTMLInputElement;

beforeEach(() => {
  document.body.innerHTML = '';
  el = document.createElement('input');
  document.body.append(el);
});

const press = async (args: Record<string, unknown>): Promise<void> => {
  await executeAction(refs.refFor(el), ActionType.PRESS, args);
};

const recordTypes = (): string[] => {
  const seen: string[] = [];
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    el.addEventListener(type, (event) => seen.push(`${event.type}:${event.key}`));
  }
  return seen;
};

describe('press dispatches browser-like keypress events', () => {
  it('fires keydown -> keypress -> keyup for a character key', async () => {
    const seen = recordTypes();
    await press({ key: '9' });
    expect(seen).toEqual(['keydown:9', 'keypress:9', 'keyup:9']);
  });

  it('fires keypress for Enter', async () => {
    const seen = recordTypes();
    await press({ key: 'Enter' });
    expect(seen).toEqual(['keydown:Enter', 'keypress:Enter', 'keyup:Enter']);
  });

  it.each(['Escape', 'Tab', 'ArrowLeft', 'Shift'])('does not fire keypress for %s', async (key) => {
    const seen = recordTypes();
    await press({ key });
    expect(seen).toEqual([`keydown:${key}`, `keyup:${key}`]);
  });

  it('does not fire keypress when keydown is cancelled', async () => {
    const seen = recordTypes();
    el.addEventListener('keydown', (event) => event.preventDefault());
    await press({ key: '9' });
    expect(seen).toEqual(['keydown:9', 'keyup:9']);
  });

  it('carries code and modifier state onto keypress', async () => {
    const seen: KeyboardEvent[] = [];
    el.addEventListener('keypress', (event) => seen.push(event));
    await press({ key: 'A', code: 'KeyA', modifiers: ['Shift'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.code).toBe('KeyA');
    expect(seen[0]?.shiftKey).toBe(true);
  });

  it('fires keypress for character keys in the multi-key path', async () => {
    const seen = recordTypes();
    await press({ keys: ['a', 'b'] });
    expect(seen).toEqual([
      'keydown:a',
      'keypress:a',
      'keydown:b',
      'keypress:b',
      'keyup:b',
      'keyup:a',
    ]);
  });

  it('suppresses combo keypress when that keydown is cancelled', async () => {
    const seen = recordTypes();
    el.addEventListener('keydown', (event) => {
      if ('b' === event.key) event.preventDefault();
    });
    await press({ keys: ['a', 'b'] });
    expect(seen).toEqual(['keydown:a', 'keypress:a', 'keydown:b', 'keyup:b', 'keyup:a']);
  });

  it('marks held-key keypress repeats as repeat events', async () => {
    const repeats: KeyboardEvent[] = [];
    el.addEventListener('keypress', (event) => {
      if (event.repeat) repeats.push(event);
    });
    await press({ key: '9', holdMs: 20 });
    expect(repeats.length).toBeGreaterThan(0);
    expect(repeats.every((event) => '9' === event.key)).toBe(true);
  });
});
