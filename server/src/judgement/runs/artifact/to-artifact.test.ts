import { describe, expect, it } from 'vitest';
import {
  PredicateKind,
  RUN_FILE_VERSION,
  Verified,
  RunConfidence,
  RunAgentKind,
  RunIdSchema,
  RunProfile,
  RunTrigger,
  VerdictStatus,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import { OPENREALITY_ARTIFACT_KIND, toArtifact } from './to-artifact.js';

/**
 * Turning what a run recorded into something somebody else can read.
 *
 * The run file is ours: it is shaped for the tools that produce it, it changes when they do, and it
 * carries things nobody outside this repository has a use for. That is fine for a file we write and
 * read, and no basis for asking anybody else to consume it.
 *
 * So there is one pure function that maps it into an export format, and the internal shapes stay
 * exactly as they are. If nobody ever adopts the format, the cost is this one file.
 *
 * The rule the mapper follows is the one that makes the whole thing worth having: **it never says
 * more than the run can back up.** Anything the run did not record is absent from the export rather
 * than defaulted, because a default is a claim, and a claim nobody checked is exactly what this
 * system exists to stop producing.
 */

const RUN: ReticleVerificationRun = {
  schemaVersion: RUN_FILE_VERSION,
  runId: RunIdSchema.parse('run-1'),
  createdAt: 1_700_000_000_000,
  durationMs: 4200,
  profile: RunProfile.PROD_PREVIEW,
  project: { name: 'shop', framework: 'react', commit: 'abc123' },
  agent: { id: 'agent-1', kind: RunAgentKind.CODING_AGENT, model: 'some-model' },
  trigger: { kind: RunTrigger.MANUAL },
  changedFiles: [],
  flows: [],
  checks: [
    { kind: PredicateKind.NET, predicate: 'POST /api/save 200', status: Verified.YES },
    { kind: PredicateKind.STATE, predicate: 'cart.items increased', status: Verified.NO },
    { kind: PredicateKind.ELEMENT, predicate: 'the toast appears', status: Verified.UNKNOWN },
    { kind: PredicateKind.TEXT, predicate: 'nothing was declared', status: Verified.NO_FAULT },
  ],
  risks: [],
  evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
  verdict: {
    status: VerdictStatus.PASS,
    reasons: ['every declared consequence held'],
    confidence: RunConfidence.HIGH,
    blockingRisks: 0,
  },
};

describe('exporting a run for somebody else to read', () => {
  it('says what kind of document it is, so a reader need not guess', () => {
    const artifact = toArtifact(RUN);
    expect(artifact.kind).toBe(OPENREALITY_ARTIFACT_KIND);
    expect(artifact.specVersion).toBe(1);
  });

  it('carries each check in the four-valued vocabulary the specification names', () => {
    // All four, and the last two are the reason this test exists. They used to be dropped here,
    // because the exported outcome was a boolean and neither value is true of them -- so the
    // document a stranger reads listed the app's failures and was silent about our own blind spots.
    const artifact = toArtifact(RUN);
    expect(artifact.checks).toEqual([
      { claim: 'POST /api/save 200', reads: PredicateKind.NET, verdict: Verified.YES },
      { claim: 'cart.items increased', reads: PredicateKind.STATE, verdict: Verified.NO },
      { claim: 'the toast appears', reads: PredicateKind.ELEMENT, verdict: Verified.UNKNOWN },
      { claim: 'nothing was declared', reads: PredicateKind.TEXT, verdict: Verified.NO_FAULT },
    ]);
  });

  it('carries the run summary and what it was based on', () => {
    const artifact = toArtifact(RUN);
    expect(artifact.summary.status).toBe(VerdictStatus.PASS);
    expect(artifact.summary.because).toEqual(['every declared consequence held']);
  });

  it('carries a correction, so a verdict can be revised where somebody else can see it', () => {
    const corrected: ReticleVerificationRun = {
      ...RUN,
      verdict: { ...RUN.verdict, checkId: 'c_1', supersedes: 'run-0#c_1' },
    };
    const artifact = toArtifact(corrected);
    expect(artifact.summary.checkId).toBe('c_1');
    expect(artifact.summary.supersedes).toBe('run-0#c_1');
  });

  it('does not carry an empty citation when nothing was corrected', () => {
    const artifact = toArtifact(RUN);
    expect('supersedes' in artifact.summary).toBe(false);
  });

  it('leaves out what the run did not record, rather than inventing a default', () => {
    // The rule that makes the export worth reading. A missing commit exported as "" or "unknown"
    // is a statement nobody made. Absent is the only honest way to say we do not know.
    const withoutCommit = { ...RUN, project: { name: 'shop', framework: 'react' as const } };
    const artifact = toArtifact(withoutCommit);
    expect(artifact.subject.commit).toBeUndefined();
    expect('commit' in artifact.subject).toBe(false);
  });

  it('is a pure function of the run, and does not reach for a clock', () => {
    // Called twice on the same input it must produce the same document. Stamping "exported at now"
    // would make two exports of one run differ, which is the opposite of what an artifact is for.
    expect(toArtifact(RUN)).toEqual(toArtifact(RUN));
  });

  it('does not claim to be signed when nothing signed it', () => {
    // Signing is a real dependency nobody has built. An artifact carrying an empty signature block
    // would look verifiable to a reader checking for one.
    expect('signature' in toArtifact(RUN)).toBe(false);
  });
});

/**
 * A correction, end to end, because the mechanism existing is not the same as it arriving.
 *
 * `reviseVerdict` sat in core for weeks with `supersedes` reaching the exported document and no
 * code path producing one. This is the test that the whole chain runs: a claim left open because
 * the outcome had not arrived, answered later in the same session, folded into a run, and
 * exported as a correction that a stranger can follow back.
 */
describe('a verdict corrected by a later one reaches the reader', () => {
  const CORRECTED: ReticleVerificationRun = {
    ...RUN,
    runId: RunIdSchema.parse('drive-9'),
    checks: [
      {
        kind: PredicateKind.NET,
        predicate: 'the order posted',
        status: Verified.UNKNOWN,
        reason: 'outcome_pending',
        checkId: 'c1',
      },
      {
        kind: PredicateKind.NET,
        predicate: 'the order posted',
        status: Verified.YES,
        checkId: 'c2',
        supersedes: 'drive-9#c1',
      },
    ],
  };

  it('carries both, so the first answer is still there', () => {
    const artifact = toArtifact(CORRECTED);
    expect(artifact.checks).toHaveLength(2);
    expect(artifact.checks[0]?.verdict).toBe(Verified.UNKNOWN);
    expect(artifact.checks[1]?.verdict).toBe(Verified.YES);
  });

  it('and the correction says which one it replaces', () => {
    // Both stand. Rewriting the first in place would erase the fact that the question was ever
    // open, and "we always knew" is the shape of the problem this system exists to prevent.
    const artifact = toArtifact(CORRECTED);
    expect(artifact.checks[1]?.supersedes).toBe('drive-9#c1');
    expect(artifact.checks[0]?.supersedes).toBeUndefined();
  });
});
