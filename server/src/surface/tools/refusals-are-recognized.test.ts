/**
 * Live, the two refusals night 7a added came back wearing "This error is not one Reticle
 * recognizes, which means it may be a defect in Reticle": an agent told to file a bug about a call
 * it only has to fix. Each already names its own fix, so nothing is appended.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefusalReason } from '@reticlehq/core';
import { claimArtifactRoot } from '@/memory/project/root-claims.js';
import { buildErrorPayload, refusalReasonFor } from './error-recovery.js';
import { emptyQueryRefusal } from './read/query-shape.js';
import { unknownFlowRefusal } from '@/language/flows/suite-selection.js';

describe('refusals that name their own fix', () => {
  it('a find with nothing to find is the caller’s to fix, not a defect', () => {
    const message = emptyQueryRefusal({})?.message ?? '';
    expect(buildErrorPayload(message)).toEqual({ error: message });
    expect(refusalReasonFor(message)).toBe(RefusalReason.BAD_ARGS);
  });

  it('an unknown flow name is a missing flow, not a defect', () => {
    const message = unknownFlowRefusal(['no-such-flow'], ['sign-in'])?.message ?? '';
    expect(buildErrorPayload(message)).toEqual({ error: message });
    expect(refusalReasonFor(message)).toBe(RefusalReason.NO_MATCH);
  });

  it('a lease root outside any project is the caller’s to fix, not a defect', () => {
    const parent = mkdtempSync(join(tmpdir(), 'reticle-root-'));
    try {
      const message = leaseRootRefusal(join(parent, 'no-such-project'));
      expect(buildErrorPayload(message)).toEqual({ error: message });
      expect(refusalReasonFor(message)).toBe(RefusalReason.BAD_ARGS);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('a relative lease root is the caller’s to fix, not a defect', () => {
    const message = leaseRootRefusal(join('work', 'shop', '.reticle'));
    expect(buildErrorPayload(message)).toEqual({ error: message });
    expect(refusalReasonFor(message)).toBe(RefusalReason.BAD_ARGS);
  });
});

/** The exact refusal the lease path throws, captured rather than retyped. */
function leaseRootRefusal(root: string): string {
  try {
    claimArtifactRoot('lease-probe', root);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`claimArtifactRoot accepted ${root}`);
}
