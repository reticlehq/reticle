import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { DepartureNote } from './departure-note.js';

const navigationPending = (url: unknown): ReticleEvent =>
  ({
    type: EventType.NET_PENDING,
    data: { id: 'nav-1', method: 'GET', url, initiator: 'navigation' },
  }) as unknown as ReticleEvent;

describe('DepartureNote', () => {
  it('starts empty', () => {
    expect(new DepartureNote().read(0)).toBeUndefined();
  });

  it('keeps the latest navigation target', () => {
    const note = new DepartureNote();
    note.observe(navigationPending('http://localhost:5173/login'), 100);
    note.observe(navigationPending('https://example.com/'), 200);
    expect(note.read(200)).toBe('https://example.com/');
  });

  it('ignores pendings that are in-flight work, not departures', () => {
    const note = new DepartureNote();
    note.observe(
      {
        type: EventType.NET_PENDING,
        data: { id: 'f-1', url: 'http://localhost:5173/api/slow' },
      } as unknown as ReticleEvent,
      100,
    );
    expect(note.read(100)).toBeUndefined();
  });

  it('ignores a navigation pending with a missing or empty url', () => {
    const note = new DepartureNote();
    note.observe(navigationPending(undefined), 100);
    note.observe(navigationPending(''), 100);
    expect(note.read(100)).toBeUndefined();
  });

  it('a stale note is not this departure', () => {
    const note = new DepartureNote();
    note.observe(navigationPending('http://localhost:5173/login'), 100);
    expect(note.read(100 + 29_999)).toBe('http://localhost:5173/login');
    expect(note.read(100 + 30_001)).toBeUndefined();
  });

  it('ignores a download — the document does not go away', () => {
    const note = new DepartureNote();
    note.observe(
      {
        type: EventType.NET_PENDING,
        data: {
          id: 'nav-1',
          method: 'GET',
          url: 'http://localhost:5173/export.pdf',
          initiator: 'navigation',
          download: true,
        },
      } as unknown as ReticleEvent,
      100,
    );
    expect(note.read(100)).toBeUndefined();
  });
});
