/**
 * A non-string `name` (or other string-typed target field) must be refused with a clear error
 * before the query runs, not silently dropped so the query matches more than the caller asked (#1777).
 *
 * Verify: removing the TARGET_STRING_FIELDS guard in act-target.ts makes every
 * "must be a string" test fail — the result becomes `{ kind: 'error', message: ... }` from the
 * QUERY path (ambiguity or missing target) instead of the type-check path.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from '@/portal/session/session.js';
import { resolveActTarget } from './act-target.js';

function sessionThatMustNotBeQueried(): Session {
  return {
    command: () => {
      throw new Error('should not query when target field type is wrong');
    },
  } as unknown as Session;
}

describe('resolveActTarget — non-string target fields', () => {
  it('refuses an object name before querying', async () => {
    const r = await resolveActTarget(sessionThatMustNotBeQueried(), {
      target: { role: 'link', name: {} },
    });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.message).toContain('target.name');
    expect(r.message).toContain('string');
  });

  it('refuses a numeric name before querying', async () => {
    const r = await resolveActTarget(sessionThatMustNotBeQueried(), {
      target: { role: 'button', name: 42 },
    });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.message).toContain('target.name');
  });

  it('refuses an array name before querying', async () => {
    const r = await resolveActTarget(sessionThatMustNotBeQueried(), {
      target: { role: 'link', name: ['Learn'] },
    });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.message).toContain('target.name');
  });

  it('does not refuse when name is a string', async () => {
    // A string name is valid; the refusal must not fire for it.
    // We do not query here — just check the early-return path does not trigger.
    const r = await resolveActTarget(sessionThatMustNotBeQueried(), {
      target: { role: 'button', name: 'Save' },
    }).catch((e: unknown) => ({ kind: 'threw' as const, e }));
    // Either the session threw (expected — we did not stub a real page) or it
    // returned an error from the query path, not from the type check.
    if (r.kind === 'error') {
      expect(r.message).not.toContain('must be a string');
    }
  });
});
