/**
 * Render an IrisVerificationRun into a legible human/agent-facing report — the "is this actually
 * useful?" moment. Pure + deterministic (no clock, no IO): the same run renders the same text, so it's
 * safe in CI and as a partner-facing artifact. Raw JSON is the contract; this is the read.
 */

import {
  RunCheckStatus,
  RunFlowStatus,
  VerdictStatus,
  type IrisVerificationRun,
  type RunCheck,
  type RunFlowResult,
  type RunRisk,
} from '@syrin/iris-protocol';

const VERDICT_GLYPH: Readonly<Record<VerdictStatus, string>> = {
  [VerdictStatus.PASS]: '✓ PASS',
  [VerdictStatus.FAIL]: '✗ FAIL',
  [VerdictStatus.PARTIAL]: '◑ PARTIAL',
};

const flowGlyph = (s: RunFlowStatus): string =>
  s === RunFlowStatus.PASS
    ? '✓'
    : s === RunFlowStatus.HEALED
      ? '✓~'
      : s === RunFlowStatus.SKIPPED
        ? '–'
        : '✗';

function flowLine(f: RunFlowResult): string {
  const head = `  ${flowGlyph(f.status)} ${f.name} (${f.steps} steps, ${f.durationMs}ms)`;
  return f.failureReason !== undefined ? `${head} — ${f.failureReason}` : head;
}

function checkLine(c: RunCheck): string {
  const glyph = c.status === RunCheckStatus.PASS ? '✓' : '✗';
  return `  ${glyph} ${c.kind}: ${c.predicate}`;
}

function riskLine(r: RunRisk): string {
  return `  ⚠ ${r.surface} (${r.severity})${r.gated ? ' [GATED]' : ''} — ${r.detail}`;
}

/** Render the run as a plain-text report. Sections with no content are omitted. */
export function renderRunReport(run: IrisVerificationRun): string {
  const out: string[] = [];
  out.push(`Iris verification — ${run.project.name}  [${run.profile}]`);
  out.push(
    `Verdict: ${VERDICT_GLYPH[run.verdict.status]}  ·  confidence: ${run.verdict.confidence}` +
      (run.verdict.blockingRisks > 0 ? `  ·  ${run.verdict.blockingRisks} blocking risk(s)` : ''),
  );

  if (run.flows.length > 0) {
    const passed = run.flows.filter(
      (f) => f.status === RunFlowStatus.PASS || f.status === RunFlowStatus.HEALED,
    ).length;
    out.push('', `Flows: ${passed}/${run.flows.length} passed`);
    for (const f of run.flows) out.push(flowLine(f));
  }

  const failedChecks = run.checks.filter((c) => c.status === RunCheckStatus.FAIL);
  if (run.checks.length > 0) {
    out.push('', `Checks: ${run.checks.length - failedChecks.length}/${run.checks.length} passed`);
    for (const c of run.checks) out.push(checkLine(c));
  }

  if (run.risks.length > 0) {
    out.push('', 'Risks:');
    for (const r of run.risks) out.push(riskLine(r));
  }

  const packets = run.repair?.failurePackets ?? [];
  if (packets.length > 0) {
    out.push('', 'How to fix:');
    for (const p of packets) {
      const where =
        p.sourceLocation !== undefined
          ? ` (${p.sourceLocation.file}${p.sourceLocation.line !== undefined ? `:${p.sourceLocation.line}` : ''})`
          : '';
      out.push(`  → ${p.flow ?? 'check'}${where}: ${p.suggestedPrompt}`);
    }
  }

  if (run.verdict.status !== VerdictStatus.PASS && run.verdict.reasons.length > 0) {
    out.push('', 'Why it failed:');
    for (const reason of run.verdict.reasons) out.push(`  - ${reason}`);
  }

  return out.join('\n');
}
