import { describe, expect, it } from 'vitest';
import { EventType, NO_EDITS_OBSERVED } from '@reticlehq/core';
import { buildEvent } from './reticle.js';

/**
 * Every event says which round of source edits it was observed under.
 *
 * Stamped in `buildEvent` for the same reason `documentId` is: it is the one place every event
 * passes through, so an observer added later cannot emit an unstamped one. Absence reads as
 * "current" downstream, which is what makes an unstamped observer a silent regression.
 */

const base = {
  seq: 1,
  t: 10,
  type: EventType.CONSOLE_ERROR,
  sessionId: 's1',
  data: {},
};

describe('buildEvent stamps the edit epoch', () => {
  it('carries the epoch it was given', () => {
    expect(buildEvent({ ...base, editEpoch: 2 }).editEpoch).toBe(2);
  });

  it('omits the field while no edit has been observed, rather than asserting none happened', () => {
    // A page with no hot-update channel — Next, Electron, Tauri, a plain page — knows nothing about
    // edits. Stamping zero on every event would spend wire on a value that means "unknown".
    expect(buildEvent({ ...base, editEpoch: NO_EDITS_OBSERVED }).editEpoch).toBeUndefined();
    expect(buildEvent(base).editEpoch).toBeUndefined();
  });

  it('leaves every other field of the envelope alone', () => {
    const event = buildEvent({ ...base, ref: 'e7', documentId: 'doc12345', editEpoch: 1 });
    expect(event.seq).toBe(1);
    expect(event.documentId).toBe('doc12345');
    expect(event.ref).toBe('e7');
  });
});
