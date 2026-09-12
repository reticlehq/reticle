import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, FlowStatus, isQuarantined, type FlowFile } from '../index.js';

/**
 * A quarantine that does not say why, who and since when does not get to remove coverage.
 *
 * Quarantine takes a flow out of the verdict. That is a real power, and the failure mode is not a
 * malformed file — it is a flow quietly leaving the suite and nobody noticing it went. So the rule
 * fails TOWARD running it: an incomplete quarantine is treated as no quarantine, the flow keeps
 * running, and whoever wanted it out has to say why.
 *
 * Enforced here rather than in the schema on purpose. A conditional schema rule would be a zod
 * `.refine()`, which this package has none of and which does not survive into the generated JSON
 * Schema — so an implementation reading the contract from `schema/` would never see the rule. A file
 * that parses and a flow that is actually excluded are two different questions, and this is the
 * second one.
 */
const flow = (over: Partial<FlowFile>): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'checkout',
  createdAt: 0,
  steps: [],
  ...over,
});

const COMPLETE = { reason: 'deploy API 500s in staging', since: '2026-09-12', owner: 'alice' };

describe('excluding a flow from the suite', () => {
  it('does not exclude an ordinary flow', () => {
    expect(isQuarantined(flow({}))).toBe(false);
  });

  it('excludes one that says why, who and when', () => {
    expect(isQuarantined(flow({ status: FlowStatus.QUARANTINED, quarantine: COMPLETE }))).toBe(
      true,
    );
  });

  it('keeps running a flow marked quarantined with NO reason given', () => {
    // The silent skip: status set, nothing said. It stays in the suite until somebody explains it.
    expect(isQuarantined(flow({ status: FlowStatus.QUARANTINED }))).toBe(false);
  });

  it('keeps running one whose quarantine names no owner', () => {
    const { owner: _owner, ...unowned } = COMPLETE;
    expect(
      isQuarantined(flow({ status: FlowStatus.QUARANTINED, quarantine: unowned as never })),
    ).toBe(false);
  });

  it('does not exclude a flow that merely carries a quarantine note without the status', () => {
    // The status is the decision; the note is the paperwork. A leftover note must not drop a flow.
    expect(isQuarantined(flow({ quarantine: COMPLETE }))).toBe(false);
  });

  it('does not exclude a draft — it is unfinished, not excused', () => {
    expect(isQuarantined(flow({ status: FlowStatus.DRAFT }))).toBe(false);
  });
});
