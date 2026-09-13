/**
 * A rewrite of the same bytes is not a change, and must not reach the buffer.
 *
 * A field app rewrote one UI key thousands of times a minute with byte-identical content. Those
 * no-op writes filled the ring buffer — `held: 2000, dropped: 70482` — and the verdict taken in that
 * window reported `net.total: 0` and "state never changed" while the POST carrying the actual root
 * cause was on the wire. The agent nearly shipped "clicking Accept fires no network request" as a
 * diagnosis. The buffer starvation is the cause; a diff whose `old` equals its `new` is the fuel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installStorage } from './storage.js';

describe('a storage write that changes nothing emits nothing', () => {
  let events: Array<{ type: EventType; data: Record<string, unknown> }>;
  let teardown: () => void;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    events = [];
    teardown = installStorage((type, data) => events.push({ type, data }));
  });
  afterEach(() => {
    teardown();
    localStorage.clear();
    sessionStorage.clear();
  });

  const changes = (): number => events.filter((e) => e.type === EventType.STORAGE_CHANGE).length;

  it('does not emit when the same value is written back', () => {
    localStorage.setItem('ui', '{"panel":"mesh"}');
    expect(changes(), 'the first write is a real change').toBe(1);
    for (let i = 0; i < 500; i += 1) localStorage.setItem('ui', '{"panel":"mesh"}');
    expect(changes(), '500 identical rewrites carry no information and must cost no buffer').toBe(
      1,
    );
  });

  it('still emits when the value actually changes', () => {
    localStorage.setItem('ui', 'a');
    localStorage.setItem('ui', 'a');
    localStorage.setItem('ui', 'b');
    expect(changes()).toBe(2);
    expect(events.at(-1)?.data).toMatchObject({ key: 'ui', old: 'a', new: 'b' });
  });

  it('emits the first write of a key that was absent', () => {
    localStorage.setItem('fresh', '');
    expect(changes(), 'absent is not the empty string').toBe(1);
  });

  it('the app still holds the value it wrote, emitted or not', () => {
    localStorage.setItem('ui', 'x');
    localStorage.setItem('ui', 'x');
    expect(localStorage.getItem('ui')).toBe('x');
  });
});
