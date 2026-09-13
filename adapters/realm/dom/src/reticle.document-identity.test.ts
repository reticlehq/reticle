import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { buildEvent } from './reticle.js';

/**
 * Every event says which document it was observed under.
 *
 * Without it, evidence is scoped by time and buffer capacity alone, so a request from a previous
 * document — or a previous run of the app — can be cited against an action taken now. The stamp is
 * what lets the server refuse that evidence instead of reporting it.
 *
 * Stamped in `buildEvent` because it is the one place every event passes through. Anywhere else and
 * an observer added later would emit unstamped events, which read as "current" by design and would
 * therefore reintroduce the defect silently for exactly one event type.
 */

const base = {
  seq: 1,
  t: 10,
  type: EventType.CONSOLE_ERROR,
  sessionId: 's1',
  data: {},
};

describe('buildEvent stamps the document', () => {
  it('carries the document id it was given', () => {
    expect(buildEvent({ ...base, documentId: 'doc12345' }).documentId).toBe('doc12345');
  });

  it('omits the field rather than inventing one when no document is known', () => {
    // Absence is read as "current document" downstream, so a fabricated id would be worse than none:
    // it would silently exclude real evidence instead of merely failing to scope it.
    expect(buildEvent(base).documentId).toBeUndefined();
  });

  it('leaves every other field of the envelope alone', () => {
    const event = buildEvent({ ...base, ref: 'e7', documentId: 'doc12345' });
    expect(event.seq).toBe(1);
    expect(event.t).toBe(10);
    expect(event.type).toBe(EventType.CONSOLE_ERROR);
    expect(event.sessionId).toBe('s1');
    expect(event.ref).toBe('e7');
  });
});
