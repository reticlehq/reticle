import { describe, expect, it } from 'vitest';
import { laneIds } from './lane-ids.js';

/** Lanes shared one id, so the last lane's synced run overwrote the others on the platform. */
describe('the id each lane runs under', () => {
  it('is its own per leased session, stable for that session', () => {
    const ids = laneIds('h1', true);
    expect(ids.idFor('lease-a')).toBe('h1-L1');
    expect(ids.idFor('lease-b')).toBe('h1-L2');
    expect(ids.idFor('lease-a')).toBe('h1-L1');
    expect(ids.all()).toEqual(['h1-L1', 'h1-L2']);
  });

  it('is the drive’s own id when nothing was leased', () => {
    const ids = laneIds('h1', false);
    expect(ids.idFor('tab')).toBe('h1');
    expect(ids.all()).toEqual(['h1']);
  });
});
