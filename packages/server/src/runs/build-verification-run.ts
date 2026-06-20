/**
 * The verification-run assembler. A PURE mapping from already-produced verification results
 * (flow-replay outcomes, standalone checks, risks, evidence, repair packets) into the stable
 * IrisVerificationRun artifact, with a deterministic verdict computed here. The clock is injected
 * (the single `createdAt` site — never Date.now() in logic, per rule 7). Gathering the inputs from a
 * live session is a separate adapter concern; this file owns the shape + the verdict rules so both
 * the MCP path and the programmatic Replay/Verify API produce byte-identical verdicts.
 */

import {
  IrisVerificationRunSchema,
  RUN_FILE_VERSION,
  RunCheckStatus,
  RunConfidence,
  RunFlowStatus,
  VerdictStatus,
  type IrisVerificationRun,
  type RunVerdict,
} from '@syrin/iris-protocol';
import { redactForProfile } from './profile-redact.js';

/** Everything a caller supplies; schemaVersion/createdAt/verdict are filled/computed by the builder. */
export type VerificationRunInput = Omit<
  IrisVerificationRun,
  'schemaVersion' | 'createdAt' | 'verdict'
>;

/**
 * Compute the verdict deterministically from the run's flows, checks, and risks.
 * Rules (in order): a gated risk blocks → FAIL; mixed pass+fail → PARTIAL; any fail → FAIL; else PASS.
 * Confidence: nothing ran → LOW; an oracle-backed flow or any check ran → HIGH; only smoke → MEDIUM.
 */
export function computeVerdict(input: VerificationRunInput): RunVerdict {
  const passes =
    input.flows.filter((f) => f.status === RunFlowStatus.PASS || f.status === RunFlowStatus.HEALED)
      .length + input.checks.filter((c) => c.status === RunCheckStatus.PASS).length;
  const fails =
    input.flows.filter((f) => f.status === RunFlowStatus.FAIL).length +
    input.checks.filter((c) => c.status === RunCheckStatus.FAIL).length;
  const blockingRisks = input.risks.filter((r) => r.gated).length;

  const reasons: string[] = [];
  for (const f of input.flows) {
    if (f.status === RunFlowStatus.FAIL) {
      reasons.push(
        f.failureReason !== undefined
          ? `flow ${f.name}: ${f.failureReason}`
          : `flow ${f.name} failed`,
      );
    }
  }
  for (const c of input.checks) {
    if (c.status === RunCheckStatus.FAIL) reasons.push(`check failed: ${c.predicate}`);
  }
  for (const r of input.risks) {
    if (r.gated) reasons.push(`blocked: ${r.surface} risk — ${r.detail}`);
  }

  let status: VerdictStatus;
  if (blockingRisks > 0) status = VerdictStatus.FAIL;
  else if (fails > 0 && passes > 0) status = VerdictStatus.PARTIAL;
  else if (fails > 0) status = VerdictStatus.FAIL;
  else status = VerdictStatus.PASS;

  const ran = input.flows.length + input.checks.length;
  let confidence: RunConfidence;
  if (ran === 0) confidence = RunConfidence.LOW;
  else if (input.flows.some((f) => f.oracle !== undefined) || input.checks.length > 0)
    confidence = RunConfidence.HIGH;
  else confidence = RunConfidence.MEDIUM;

  return { status, reasons, confidence, blockingRisks };
}

/**
 * Assemble the final, schema-valid IrisVerificationRun. Stamps schemaVersion + createdAt (injected
 * clock) and computes the verdict; the result is parsed through the protocol schema so a malformed
 * input can never escape as an "artifact".
 */
export function buildVerificationRun(
  input: VerificationRunInput,
  now: () => number,
): IrisVerificationRun {
  const run = {
    schemaVersion: RUN_FILE_VERSION,
    createdAt: now(),
    verdict: computeVerdict(input),
    ...input,
  };
  return redactForProfile(IrisVerificationRunSchema.parse(run));
}
