/**
 * Two correct writes that used to be graded as dropped fields (`reticlehq/reticle#1345`):
 *
 *  - a POST sent `detected_at: "2026-10-02T15:15:00.000Z"` and the server echoed
 *    `"2026-10-02T15:15:00Z"` — the same instant, spelled differently;
 *  - a PATCH carried `updated_at` and the server replaced it with the current time, which is what an
 *    audit column is for.
 *
 * A user's own date field that comes back as a different day is still a dropped write.
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
      method: 'PATCH',
      url: '/api/incidents/1',
      status: 200,
      requestBody: JSON.stringify(requestBody),
      responseBody: JSON.stringify(responseBody),
    },
  }) as unknown as ReticleEvent;

describe('a timestamp is compared as an instant, and an audit column is not compared', () => {
  it('stays silent when the echo drops the milliseconds of the same instant', () => {
    const found = findEchoMismatches([
      write(
        { title: 'Outage', detected_at: '2026-10-02T15:15:00.000Z' },
        { title: 'Outage', detected_at: '2026-10-02T15:15:00Z' },
      ),
    ]);
    expect(found).toEqual([]);
  });

  it('stays silent when the echo spells the same instant with an offset', () => {
    const found = findEchoMismatches([
      write(
        { title: 'Outage', detected_at: '2026-10-02T15:15:00Z' },
        { title: 'Outage', detected_at: '2026-10-02T20:45:00+05:30' },
      ),
    ]);
    expect(found).toEqual([]);
  });

  it('still catches a timestamp the server moved to a different instant', () => {
    const found = findEchoMismatches([
      write(
        { title: 'Outage', detected_at: '2026-10-02T15:15:00Z' },
        { title: 'Outage', detected_at: '2026-10-02T15:16:00Z' },
      ),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.counter).toContain('detected_at');
  });

  it.each(['updated_at', 'updatedAt', 'modified_at', 'last_modified'])(
    'stays silent when the server overwrites %s with its own time',
    (key) => {
      const found = findEchoMismatches([
        write(
          { title: 'Outage', [key]: '2026-10-02T15:15:00Z' },
          { title: 'Outage', [key]: '2026-10-07T09:00:00Z' },
        ),
      ]);
      expect(found).toEqual([]);
    },
  );

  it('still catches a user date field that came back as a different day', () => {
    const found = findEchoMismatches([
      write(
        { title: 'Outage', due_date: '2026-03-01', updated_at: '2026-10-02T15:15:00Z' },
        { title: 'Outage', due_date: '2026-03-02', updated_at: '2026-10-07T09:00:00Z' },
      ),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.WRITE_FIELD_IGNORED);
    expect(found[0]?.counter).toContain('due_date');
    expect(found[0]?.counter).not.toContain('updated_at');
  });
});
