import { describe, it, expect } from 'vitest';
import { registerStore, unregisterStore, storeNames, readStores } from './stores.js';

describe('store registry (G2 pull-based state)', () => {
  it('registers a store and reads it back', () => {
    registerStore('ws_a', () => ({ items: 3 }));
    expect(readStores()).toMatchObject({ ws_a: { items: 3 } });
    expect(storeNames()).toContain('ws_a');
    unregisterStore('ws_a');
  });

  it('filters to a single store by name; unknown name yields empty', () => {
    registerStore('ws_b', () => 1);
    registerStore('ws_c', () => 2);
    expect(readStores('ws_b')).toEqual({ ws_b: 1 });
    expect(readStores('nope')).toEqual({});
    unregisterStore('ws_b');
    unregisterStore('ws_c');
  });

  it('isolates a throwing getter as an __error; other stores still read', () => {
    registerStore('ws_bad', () => {
      throw new Error('boom');
    });
    registerStore('ws_ok', () => 42);
    const out = readStores();
    expect(out['ws_bad']).toEqual({ __error: 'boom' });
    expect(out['ws_ok']).toBe(42);
    unregisterStore('ws_bad');
    unregisterStore('ws_ok');
  });

  it('unregisterStore removes it', () => {
    registerStore('ws_d', () => 0);
    expect(storeNames()).toContain('ws_d');
    unregisterStore('ws_d');
    expect(storeNames()).not.toContain('ws_d');
  });
});
