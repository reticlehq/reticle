/**
 * What makes two writes to one endpoint THE SAME write.
 *
 * Reported from the field: one submit that intentionally sends a `save-player` action and then an
 * `advance-setup` action to the same POST endpoint came back `duplicate-request` and `unknown`,
 * with both requests successful and the declared state matching. Method plus URL cannot separate
 * those two, and the request body that could is not on the record by default — capturing it would
 * put passwords and tokens on the wire.
 *
 * So the page sends a fingerprint of the body's SHAPE instead, and this file pins the three
 * outcomes that fingerprint has to produce: different writes are not a duplicate, identical ones
 * still are, and a window where the fingerprint is missing for any call SAYS the identity could not
 * be established rather than quietly answering either way.
 */
import { describe, it, expect } from 'vitest';
import {
  ContradictionKind,
  EventType,
  REQUEST_SHAPE_FIELD,
  REQUEST_SHAPE_NONE,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

const URL_UNDER_TEST = '/api/setup';

let seq = 0;
function write(shape?: string): ReticleEvent {
  seq += 1;
  return {
    t: seq * 37,
    seq,
    type: EventType.NET_REQUEST,
    sessionId: 's',
    data: {
      id: `n${String(seq)}`,
      method: 'POST',
      url: URL_UNDER_TEST,
      status: 200,
      ok: true,
      ...(shape === undefined ? {} : { [REQUEST_SHAPE_FIELD]: shape }),
    },
  };
}

function domChanged(): ReticleEvent {
  seq += 1;
  return {
    t: seq * 37,
    seq,
    type: EventType.DOM_REMOVED,
    sessionId: 's',
    data: { path: 'li' },
  };
}

function duplicates(events: ReticleEvent[]): { kind: string; detail?: string }[] {
  return findContradictions(events, { actionSince: 0 }).filter(
    (c) =>
      c.kind === ContradictionKind.DUPLICATE_REQUEST ||
      c.kind === ContradictionKind.DUPLICATE_REQUEST_UNRELATED,
  );
}

/** The fingerprints two genuinely different payloads produce — opaque to everything downstream. */
const SAVE_PLAYER = '1a2b3c4d';
const ADVANCE_SETUP = '9f8e7d6c';

describe('two sequential writes to one endpoint', () => {
  it('are not a double submit when their bodies differed', () => {
    const events = [write(SAVE_PLAYER), write(ADVANCE_SETUP), domChanged()];
    expect(duplicates(events)).toEqual([]);
  });

  it('are still a double submit when their bodies were identical', () => {
    const events = [write(SAVE_PLAYER), write(SAVE_PLAYER), domChanged()];
    expect(duplicates(events).map((c) => c.kind)).toEqual([ContradictionKind.DUPLICATE_REQUEST]);
  });

  it('are a double submit when neither carried a body at all', () => {
    // An absent body is a KNOWN discriminator, not a missing one: two bodyless POSTs to one URL are
    // indistinguishable to the server too.
    const events = [write(REQUEST_SHAPE_NONE), write(REQUEST_SHAPE_NONE), domChanged()];
    const [found] = duplicates(events);
    expect(found?.kind).toBe(ContradictionKind.DUPLICATE_REQUEST);
    expect(found?.detail).not.toContain('could not');
  });
});

describe('a window where the body discriminator is missing', () => {
  it('says the identity could not be established rather than asserting a duplicate', () => {
    const events = [write(), write(), domChanged()];
    const [found] = duplicates(events);
    expect(found?.kind).toBe(ContradictionKind.DUPLICATE_REQUEST);
    expect(found?.detail).toContain('could not be established');
  });

  it('reports the same way when only ONE of the calls carried a discriminator', () => {
    // The half-known window used to resolve silently: the two calls landed in different buckets, so
    // a real double submit produced no finding at all while the fully-unknown window produced one.
    const events = [write(SAVE_PLAYER), write(), domChanged()];
    const [found] = duplicates(events);
    expect(found?.kind).toBe(ContradictionKind.DUPLICATE_REQUEST);
    expect(found?.detail).toContain('could not be established');
  });

  it('keeps the advisory downgrade for an endpoint the assertion never named', () => {
    const events = [write(), write(), domChanged()];
    const found = findContradictions(events, { actionSince: 0, namedNetUrls: ['/api/other'] });
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.DUPLICATE_REQUEST_UNRELATED);
  });
});
