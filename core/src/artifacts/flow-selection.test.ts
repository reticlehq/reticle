import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, FlowFileSchema, FlowStatus } from '../index.js';

/**
 * A suite needs to name a subset, and needs to stop running a flow that has failed every time.
 *
 * Measured on this repo's own `.reticle/flake.json`: `sweep-flow` has failed 366 of 366 runs and is
 * still replayed on every suite. That is not a regression signal — it is noise that teaches people
 * to skip the suite, which is the most expensive thing a test suite can do.
 *
 * Both need somewhere to live on the flow itself, because both have to survive being committed and
 * read back by a teammate who was not here.
 */
const base = {
  version: FLOW_FILE_VERSION,
  name: 'checkout',
  createdAt: 0,
  steps: [],
};

describe('a flow can be selected and quarantined', () => {
  it('parses a flow with no labels — every existing flow still loads', () => {
    // Back-compat is the whole reason these are optional: 50 flows are already on disk.
    const parsed = FlowFileSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.labels).toBeUndefined();
  });

  it('carries labels, so a suite can ask for a subset', () => {
    const parsed = FlowFileSchema.safeParse({ ...base, labels: ['smoke', 'checkout'] });
    expect(parsed.success && parsed.data.labels).toEqual(['smoke', 'checkout']);
  });

  it('carries a status, defaulting to active when absent', () => {
    const parsed = FlowFileSchema.safeParse(base);
    expect(parsed.success && parsed.data.status).toBeUndefined();
    const quarantined = FlowFileSchema.safeParse({ ...base, status: FlowStatus.QUARANTINED });
    expect(quarantined.success).toBe(true);
  });

  it('refuses a quarantine with no reason and no owner', () => {
    // Quarantine has to be visible, owned and dated, or it is a silent skip — which is how a
    // permanently broken flow stops being anybody's problem while still counting as coverage.
    const noReason = FlowFileSchema.safeParse({
      ...base,
      status: FlowStatus.QUARANTINED,
      quarantine: { since: '2026-09-12', owner: 'alice' },
    });
    expect(noReason.success).toBe(false);
  });

  it('accepts a quarantine that says why, who and when', () => {
    const parsed = FlowFileSchema.safeParse({
      ...base,
      status: FlowStatus.QUARANTINED,
      quarantine: {
        reason: 'the deploy API 500s in staging; tracked in #412',
        since: '2026-09-12',
        owner: 'alice',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a status it does not know, rather than treating it as active', () => {
    expect(FlowFileSchema.safeParse({ ...base, status: 'disabled' }).success).toBe(false);
  });
});
