/**
 * A hook payload must not have a field a credential could live in.
 *
 * The incident this cites is not a hook one — hooks are new — it is the reason the HUD's own
 * `AccountState` was built the way it was, recorded in `core/src/artifacts/impact.ts`: a shape
 * pushed OUT of the daemon had to be designed so that a token could not be put in it later by
 * someone who did not know, because the field would look ordinary and the leak would look like
 * working software. That file says "there is no field for one and the reader is tested for never
 * emitting one". A hook payload leaves the daemon the same way and needs the same check.
 *
 * It reads the SCHEMAS rather than a list of field names kept by hand, so a field added to a payload
 * next year is covered the day it is added rather than the day somebody remembers this file.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BugFoundHookPayloadSchema,
  HOOK_EVENT_NAMES,
  HookEvent,
  SessionHookPayloadSchema,
  SyncHookPayloadSchema,
  VerdictHookPayloadSchema,
} from './hook-events.js';

/** Every payload schema, by the event it belongs to. */
const SCHEMAS: ReadonlyArray<readonly [string, z.ZodObject<z.ZodRawShape>]> = [
  [HookEvent.VERDICT, VerdictHookPayloadSchema],
  [HookEvent.BUG_FOUND, BugFoundHookPayloadSchema],
  ['session', SessionHookPayloadSchema],
  [HookEvent.SYNC_COMPLETED, SyncHookPayloadSchema],
];

/**
 * Field names a credential wears.
 *
 * Substring matching on purpose: `apiKey`, `api_key`, `pairingToken` and `authorization` all have
 * to fail, and enumerating spellings is how a list goes stale. A false positive here costs one
 * conversation about a name; a false negative ships somebody's key into a log.
 */
const SECRET_SHAPED = ['token', 'key', 'secret', 'password', 'credential', 'auth', 'cookie'];

describe('a hook payload has nowhere to put a credential', () => {
  it('declares a field for every event, so this test cannot pass by finding none', () => {
    expect(SCHEMAS.length).toBeGreaterThan(3);
    for (const [name, schema] of SCHEMAS) {
      expect(Object.keys(schema.shape).length, `${name} has no fields`).toBeGreaterThan(1);
    }
  });

  it('has no secret-shaped field on any payload', () => {
    const offenders: string[] = [];
    for (const [name, schema] of SCHEMAS) {
      for (const field of Object.keys(schema.shape)) {
        const lower = field.toLowerCase();
        if (SECRET_SHAPED.some((word) => lower.includes(word))) offenders.push(`${name}.${field}`);
      }
    }
    expect(
      offenders,
      'a hook payload leaves this process and may be written to a log nobody here controls',
    ).toEqual([]);
  });

  it('strips an unknown field rather than passing it through', () => {
    // zod objects are strip-by-default, and that default is load-bearing here: it means a caller
    // that spreads a wider internal object into a payload cannot smuggle its extra fields out.
    const parsed = VerdictHookPayloadSchema.parse({
      event: HookEvent.VERDICT,
      at: '2026-01-01T00:00:00.000Z',
      tool: 'reticle_assert',
      verified: 'yes',
      pairingToken: 'super-secret',
    });
    expect(Object.prototype.hasOwnProperty.call(parsed, 'pairingToken')).toBe(false);
  });

  it('names every event in HOOK_EVENT_NAMES, so a config can be validated against it', () => {
    expect(HOOK_EVENT_NAMES).toContain(HookEvent.VERDICT);
    expect(HOOK_EVENT_NAMES).toContain(HookEvent.BUG_FOUND);
    expect(new Set(HOOK_EVENT_NAMES).size, 'a duplicate name would shadow a real event').toBe(
      HOOK_EVENT_NAMES.length,
    );
  });
});
