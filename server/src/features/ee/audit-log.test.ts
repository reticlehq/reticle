import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { EnterpriseLicenseError } from '../license/license.js';
import { recordAuditEvent } from './audit-log.js';

/** The gated enterprise example: free in dev/eval, blocked in production without a license. */
const NOW = 1_700_000_000_000;
const { publicKey } = generateKeyPairSync('ed25519');

describe('recordAuditEvent (gated ee feature)', () => {
  it('works in dev/eval', () => {
    const event = { actor: 'a', action: 'x', at: NOW };
    expect(recordAuditEvent(event, { requireLicense: false, now: () => NOW })).toEqual(event);
  });

  it('is blocked in unlicensed production', () => {
    const event = { actor: 'a', action: 'x', at: NOW };
    expect(() =>
      recordAuditEvent(event, { requireLicense: true, now: () => NOW, publicKey }),
    ).toThrow(EnterpriseLicenseError);
  });
});
