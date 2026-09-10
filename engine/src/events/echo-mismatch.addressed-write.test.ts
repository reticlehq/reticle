/**
 * An ADDRESSED write says "set the field named X to V". Its `value` key is a container, not a field.
 *
 * Measured in the field, and it produced a FALSE RED on an assertion that had passed. The request
 * asked `{"slot":"_dim","value":"3D"}`. The server applied it: `brief.dim: "3D"`, and the interview
 * advanced from `{kind:"question"}` to `{kind:"geometry", payload:{module:"fluids", dim:"3D"}}`.
 * `write-field-ignored` reported "its own echo shows 1 field(s) NOT applied — value: asked 3d, got
 * cfd", where `cfd` is `brief.slots._family.value` — a DIFFERENT slot, set earlier in the same
 * interview. The heuristic had compared the request's `value` against the first `value` node it
 * found anywhere in the response.
 *
 * Proof it was the heuristic and not the app: the very next call on the same endpoint,
 * `{"slot":"geometry.openings.main_top.boundary_condition","value":"inlet"}`, DOES mirror into
 * `slots.*` and produced a clean `verified: "yes"`. So it misfired only where a server persists an
 * addressed field somewhere other than a mirror named after it — a normal API shape, not a defect.
 *
 * Why a manufactured red costs more than a missed one: Reticle's proposition is that only green
 * means green and that an agent must not talk itself past a red. A heuristic that invents reds
 * inverts it — inside one session it taught the reporter that a `contradicted` verdict may be noise
 * worth arguing with, which is precisely the reflex this product exists to suppress.
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
      url: '/api/v0/interview/itv_726e34fd39/answer',
      status: 200,
      requestBody: JSON.stringify(requestBody),
      responseBody: JSON.stringify(responseBody),
    },
  }) as unknown as ReticleEvent;

/** The response as it actually came back: the field applied, under its own name, not as a mirror. */
const INTERVIEW = {
  brief: {
    dim: '3D',
    slots: { _family: { value: 'cfd' }, _module: { value: 'fluids' } },
  },
  step: { kind: 'geometry', payload: { module: 'fluids', dim: '3D' } },
};

describe('an addressed write is not compared through its container key', () => {
  it('stays silent when the addressed field landed somewhere other than a mirror', () => {
    expect(findEchoMismatches([write({ slot: '_dim', value: '3D' }, INTERVIEW)])).toEqual([]);
  });

  it.each(['field', 'key', 'path', 'property'])(
    'treats %s as an addressing key too — the shape is what matters, not the spelling',
    (addressing) => {
      const request = { [addressing]: 'locale', value: 'fr' };
      const response = { settings: { theme: { value: 'dark' } }, locale: 'fr' };
      expect(findEchoMismatches([write(request, response)])).toEqual([]);
    },
  );

  it('still reports a differing ADDRESSING key — a redirected write is a real dropped write', () => {
    const found = findEchoMismatches([
      write({ slot: '_dim', value: '3D' }, { slot: '_family', value: '3D', ok: true }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.WRITE_FIELD_IGNORED);
    expect(found[0]?.counter).toContain('slot');
  });

  it('leaves an ordinary flat write alone — this guard must not widen into a mute button', () => {
    const found = findEchoMismatches([
      write({ density: 'compact', locale: 'fr' }, { ok: true, density: 'compact', locale: 'en' }),
    ]);
    expect(found, 'the archetype this kind exists for must still fire').toHaveLength(1);
    expect(found[0]?.counter).toContain('locale');
  });

  it('leaves a write alone that carries a value with no addressing key beside it', () => {
    const found = findEchoMismatches([write({ value: 'fr' }, { ok: true, value: 'en' })]);
    expect(found, 'a bare {value} names its own field by being the only one').toHaveLength(1);
  });
});
