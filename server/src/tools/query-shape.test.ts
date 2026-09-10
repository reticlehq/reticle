/**
 * The same concept spelled two ways on one surface.
 *
 * `reticle_query` asks for a STRATEGY and a value — `{ by: 'text', value: 'Deploy' }`. The predicate
 * every other tool takes asks for NAMED FIELDS — `{ text: 'Deploy' }`, `{ testid: 'submit' }` — as in
 * `reticle_act_and_wait { until: { kind: 'element', query: { text } } }` and `reticle_assert`.
 *
 * So an agent that has learned the element query from the predicate (which is where it is used most)
 * and applies it to `reticle_query` gets `-32602: Unknown parameter for reticle_query: text`. I hit
 * exactly this on my own first call of the night, before knowing anything about the codebase.
 *
 * That matters more here than a papercut usually would: of the 25 sessions that called any tool in a
 * day, 13 made exactly ONE call and stopped. A rejected first call is a bounced session. Accepting
 * the shape the rest of the surface teaches costs nothing and removes a first-call failure.
 */

import { describe, expect, it } from 'vitest';
import { normalizeQueryArgs } from './query-shape.js';

describe('normalizeQueryArgs', () => {
  it('passes an explicit by/value through untouched', () => {
    expect(normalizeQueryArgs({ by: 'testid', value: 'submit' })).toMatchObject({
      by: 'testid',
      value: 'submit',
    });
  });

  it('accepts the predicate shape the rest of the surface teaches', () => {
    expect(normalizeQueryArgs({ text: 'Deploy' })).toMatchObject({ by: 'text', value: 'Deploy' });
    expect(normalizeQueryArgs({ testid: 'submit' })).toMatchObject({
      by: 'testid',
      value: 'submit',
    });
    expect(normalizeQueryArgs({ role: 'button' })).toMatchObject({ by: 'role', value: 'button' });
  });

  it('prefers the most specific field when several are given, like the predicate does', () => {
    // testid is the gold-standard anchor everywhere else in Reticle; role is the broadest.
    expect(normalizeQueryArgs({ testid: 'submit', role: 'button', text: 'Go' })).toMatchObject({
      by: 'testid',
      value: 'submit',
    });
  });

  it('keeps role + name together — the one combination the predicate relies on', () => {
    const out = normalizeQueryArgs({ role: 'button', name: 'Sign in' });
    expect(out).toMatchObject({ by: 'role', value: 'button', name: 'Sign in' });
  });

  it('an explicit by/value WINS over a named field, so nothing existing changes meaning', () => {
    expect(normalizeQueryArgs({ by: 'role', value: 'button', text: 'ignored' })).toMatchObject({
      by: 'role',
      value: 'button',
    });
  });

  it('leaves a call with neither shape alone, so the schema error still explains itself', () => {
    // Inventing a query here would turn "you forgot the arguments" into a confident wrong answer.
    const out = normalizeQueryArgs({ limit: 5 });
    expect(out['by']).toBeUndefined();
    expect(out['value']).toBeUndefined();
  });

  it('carries the untouched params through', () => {
    const out = normalizeQueryArgs({ text: 'Deploy', limit: 3, scope: '#main', sessionId: 's1' });
    expect(out).toMatchObject({
      by: 'text',
      value: 'Deploy',
      limit: 3,
      scope: '#main',
      sessionId: 's1',
    });
  });
});
