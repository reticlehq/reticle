import { describe, expect, it } from 'vitest';
import {
  PredicateKind,
  RUN_FILE_VERSION,
  RunAgentKind,
  Verified,
  RunConfidence,
  RunIdSchema,
  RunProfile,
  RunTrigger,
  VerdictStatus,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import { toArtifact } from './to-artifact.js';

/**
 * The four things that make this different from every test report that already exists.
 *
 * A report saying "12 passed, 1 failed" is a thing the world has plenty of. Four properties are what
 * make a Reticle verdict a different kind of document, and all four were implemented and none of
 * them reached the exported artifact -- which made the export, structurally, an ordinary test report.
 *
 *   1. The claim was written down BEFORE the action. That is the whole difference between a check
 *      and a rationalisation: afterwards, anything that happened can be described as what you meant.
 *   2. The verdict carries the GRADE of evidence behind it. A green bought with "something matching
 *      was on screen" is not the same green as one bought with "the request went out", and a report
 *      that flattens them lets the cheap one masquerade as the dear one.
 *   3. The verdict states WHAT IT COULD NOT SEE. This is the one with no prior art anywhere: every
 *      other test report in existence is silent about its own blind spots.
 *   4. The evidence is bound to a ROUND OF SOURCE EDITS. Evidence gathered before the change under
 *      test is true about the old code, and reporting it as true about the new code is a false pass.
 */

const run = (over: Partial<ReticleVerificationRun> = {}): ReticleVerificationRun => ({
  schemaVersion: RUN_FILE_VERSION,
  runId: RunIdSchema.parse('run-1'),
  createdAt: 1_700_000_000_000,
  durationMs: 4200,
  profile: RunProfile.PROD_PREVIEW,
  project: { name: 'shop', framework: 'react' },
  agent: { id: 'a', kind: RunAgentKind.CODING_AGENT },
  trigger: { kind: RunTrigger.EDIT },
  changedFiles: [],
  flows: [],
  checks: [
    {
      kind: PredicateKind.NET,
      predicate: 'POST /api/save 200',
      status: Verified.YES,
      declaredBeforeActing: true,
      grade: 'net',
      couldNotSee: [],
    },
  ],
  risks: [],
  evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
  editEpoch: 7,
  verdict: {
    status: VerdictStatus.PASS,
    reasons: ['it held'],
    confidence: RunConfidence.HIGH,
    blockingRisks: 0,
  },
  ...over,
});

describe('the exported artifact carries what makes a verdict a verdict', () => {
  it('says the claim was written down before the action', () => {
    const [check] = toArtifact(run()).checks;
    expect(check?.declaredBeforeActing).toBe(true);
  });

  it('says what grade of evidence bought the answer', () => {
    const [check] = toArtifact(run()).checks;
    expect(check?.grade).toBe('net');
  });

  it('says what it could not see', () => {
    const artifact = toArtifact(
      run({
        checks: [
          {
            kind: PredicateKind.NET,
            predicate: 'POST /api/save 200',
            status: Verified.YES,
            declaredBeforeActing: true,
            grade: 'net',
            couldNotSee: ['closed-shadow-root'],
          },
        ],
      }),
    );
    expect(artifact.checks[0]?.couldNotSee).toEqual(['closed-shadow-root']);
  });

  it('binds the evidence to a round of source edits', () => {
    expect(toArtifact(run()).editEpoch).toBe(7);
  });

  it('leaves each of them out rather than guessing, when the run did not record it', () => {
    // The rule the whole mapper follows. `declaredBeforeActing: false` is a statement that the claim
    // came afterwards; absence means nobody recorded which, and those are different facts. Defaulting
    // the first three to a comfortable value would make the export say things nobody checked.
    const artifact = toArtifact(
      run({
        editEpoch: undefined,
        checks: [{ kind: PredicateKind.NET, predicate: 'x', status: Verified.YES }],
      }),
    );
    expect('editEpoch' in artifact).toBe(false);
    expect('declaredBeforeActing' in (artifact.checks[0] ?? {})).toBe(false);
    expect('grade' in (artifact.checks[0] ?? {})).toBe(false);
    expect('couldNotSee' in (artifact.checks[0] ?? {})).toBe(false);
  });
});
