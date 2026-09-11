import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageContextKind } from '@reticlehq/core/telemetry';
import {
  IDENTIFY_NOTICE,
  clearIdentity,
  readIdentity,
  saveIdentity,
  submitIdentity,
} from './identify.js';

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'reticle-id-')), 'identity.json');

/**
 * `reticle identify` is the only path by which Reticle ever learns who someone is, and every test
 * here is really a test of that boundary: it happens because a human typed a command, it says what it
 * links before it links it, and it can be undone.
 */
describe('identify — opt-in, never inferred', () => {
  it('round-trips an identity through disk', () => {
    const file = tempFile();
    try {
      saveIdentity(
        { context: UsageContextKind.COMPANY, company: 'Acme', email: 'a@acme.com' },
        file,
      );
      expect(readIdentity(file)).toEqual({
        context: UsageContextKind.COMPANY,
        company: 'Acme',
        email: 'a@acme.com',
      });
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('lets someone declare a context without naming a company or leaving an email', () => {
    const file = tempFile();
    try {
      saveIdentity({ context: UsageContextKind.SIDE_PROJECT }, file);
      const read = readIdentity(file);
      expect(read?.context).toBe(UsageContextKind.SIDE_PROJECT);
      expect(read?.company).toBeUndefined();
      expect(read?.email).toBeUndefined();
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('is absent by default — no identity exists unless someone created one', () => {
    expect(
      readIdentity(join(tmpdir(), 'reticle-identity-that-does-not-exist.json')),
    ).toBeUndefined();
  });

  it('forgets on request, and tolerates forgetting when there is nothing there', () => {
    const file = tempFile();
    saveIdentity({ context: UsageContextKind.LEARNING }, file);
    clearIdentity(file);
    expect(readIdentity(file)).toBeUndefined();
    expect(() => clearIdentity(file)).not.toThrow();
  });

  it('survives a corrupt file rather than throwing on a CLI startup path', () => {
    const file = tempFile();
    try {
      writeFileSync(file, 'not json at all');
      expect(readIdentity(file)).toBeUndefined();
    } finally {
      rmSync(file, { force: true });
    }
  });

  /**
   * The notice must state the non-obvious consequence — that identifying yourself links the anonymous
   * history already collected from this machine. That is the fact a consent notice usually omits, and
   * it is exactly the one a person needs before choosing, not after.
   */
  it('discloses that it links prior anonymous usage, and how to undo it', () => {
    expect(IDENTIFY_NOTICE).toMatch(/anonymous/i);
    expect(IDENTIFY_NOTICE).toMatch(/already recorded/i);
    expect(IDENTIFY_NOTICE).toMatch(/--forget/);
  });

  it('reports non-delivery instead of pretending when telemetry is off', async () => {
    // Under vitest the emitter is a hard no-op, which is the case that must be reported honestly.
    await expect(submitIdentity({ context: UsageContextKind.COMPANY })).resolves.toBe(false);
  });
});
