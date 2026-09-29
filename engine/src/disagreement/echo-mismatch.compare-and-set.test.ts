/**
 * A compare-and-set write sends the version it read and expects the server to bump it. The bumped
 * `version` in the response IS the proof the write applied — it is not a field the caller asked the
 * server to preserve, the same way a create's assigned `id` is not.
 *
 * Reported from the field, on `reticlehq/reticle#984`, as the single most-reported shape of
 * `write-field-ignored`: `POST /trpc/reports.submit` returned 200 with a body confirming the
 * submission, the request carried `version: 1` for optimistic concurrency, and the response's
 * incremented `version: 2` was read as a dropped write — because nothing here distinguishes an
 * optimistic-concurrency token from an ordinary persisted field. Reported on four separate apps.
 */
import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findEchoMismatches } from './echo-mismatch.js';

let seq = 0;
const write = (requestBody: unknown, responseBody: unknown): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: ++seq,
    data: {
      id: `n${String(seq)}`,
      method: 'POST',
      url: '/trpc/reports.submit',
      status: 200,
      requestBody: JSON.stringify(requestBody),
      responseBody: JSON.stringify(responseBody),
    },
  }) as unknown as ReticleEvent;

describe('a compare-and-set version token is not compared as a persisted field', () => {
  it('stays silent when the server echoes the version it bumped, not the one that was sent', () => {
    const found = findEchoMismatches([
      write({ id: 'rep_1', version: 1 }, { status: 'submitted', version: 2 }),
    ]);
    expect(found).toEqual([]);
  });

  it('still catches a real dropped field alongside an unrelated version bump', () => {
    const found = findEchoMismatches([
      write(
        { id: 'rep_1', version: 1, priority: 'high' },
        { status: 'submitted', version: 2, priority: 'normal' },
      ),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.WRITE_FIELD_IGNORED);
    expect(found[0]?.counter).toContain('priority');
    expect(found[0]?.counter).not.toContain('version');
  });
});
