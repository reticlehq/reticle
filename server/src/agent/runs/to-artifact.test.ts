import { describe, expect, it } from 'vitest';
import {
  PredicateKind,
  RUN_FILE_VERSION,
  RunCheckStatus,
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
    { kind: PredicateKind.NET, predicate: 'POST /api/save 200', status: RunCheckStatus.PASS },
    { kind: PredicateKind.STATE, predicate: 'cart.items increased', status: RunCheckStatus.FAIL },
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

  it('carries each check in the vocabulary the specification names', () => {
    const artifact = toArtifact(RUN);
    expect(artifact.checks).toEqual([
      { claim: 'POST /api/save 200', reads: PredicateKind.NET, held: true },
      { claim: 'cart.items increased', reads: PredicateKind.STATE, held: false },
    ]);
  });

  it('carries the verdict and what it was based on', () => {
    const artifact = toArtifact(RUN);
    expect(artifact.verdict.status).toBe(VerdictStatus.PASS);
    expect(artifact.verdict.because).toEqual(['every declared consequence held']);
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
