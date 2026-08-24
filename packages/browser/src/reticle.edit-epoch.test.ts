import { describe, expect, it } from 'vitest';
import { EventType, NO_EDITS_OBSERVED } from '@reticlehq/core';
import { buildEvent } from './reticle.js';

/**
 * Every event says which round of source edits it was observed under.
 *
 * Stamped in `buildEvent` for the same reason `documentId` is: it is the one place every event
 * passes through, so an observer added later cannot emit an unstamped one.
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

  it('stamps zero as zero so pre-edit events stay distinguishable after a hot update', () => {
    // Omitting `NO_EDITS_OBSERVED` made `isSameEditEpoch(undefined, 1)` read as current, so
    // EVIDENCE_PREDATES_EDIT never fired for events emitted before the first edit.
    expect(buildEvent({ ...base, editEpoch: NO_EDITS_OBSERVED }).editEpoch).toBe(NO_EDITS_OBSERVED);
    expect(buildEvent(base).editEpoch).toBeUndefined();
  });

  it('leaves every other field of the envelope alone', () => {
    const event = buildEvent({ ...base, ref: 'e7', documentId: 'doc12345', editEpoch: 1 });
    expect(event.seq).toBe(1);
    expect(event.documentId).toBe('doc12345');
    expect(event.ref).toBe('e7');
  });
});
