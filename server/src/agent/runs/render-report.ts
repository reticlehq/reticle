/**
 * Render an ReticleVerificationRun into a legible human/agent-facing report — the "is this actually
 * useful?" moment. Pure + deterministic (no clock, no IO): the same run renders the same text, so it's
 * safe in CI and as a partner-facing artifact. Raw JSON is the contract; this is the read.
 */

import {
  Verified,
  RunFlowStatus,
  VerdictStatus,
  type ReticleVerificationRun,
  type RunCheck,
  type RunFlowResult,
  type RunRisk,
} from '@reticlehq/core';

const VERDICT_GLYPH: Readonly<Record<VerdictStatus, string>> = {
  [VerdictStatus.PASS]: '✓ PASS',
  [VerdictStatus.FAIL]: '✗ FAIL',
  [VerdictStatus.PARTIAL]: '◑ PARTIAL',
  [VerdictStatus.UNKNOWN]: '? NOTHING PROVED',
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

/**
 * One glyph per verdict, and four of them.
 *
 * A check that could not be decided used to print `✗`, because anything that was not a pass was
 * rendered as a failure. That told a reader the app was broken when the truth was that we could not
 * see -- opposite next moves, one symbol.
 */
const CHECK_GLYPH: Record<Verified, string> = {
  [Verified.YES]: '✓',
  [Verified.NO]: '✗',
  [Verified.UNKNOWN]: '?',
  [Verified.NO_FAULT]: '–',
};

function checkLine(c: RunCheck): string {
  return `  ${CHECK_GLYPH[c.status]} ${c.kind}: ${c.predicate}`;
}

function riskLine(r: RunRisk): string {
  return `  ⚠ ${r.surface} (${r.severity})${r.gated ? ' [GATED]' : ''} — ${r.detail}`;
}

/** Render the run as a plain-text report. Sections with no content are omitted. */
export function renderRunReport(run: ReticleVerificationRun): string {
  const out: string[] = [];
  out.push(`Reticle verification — ${run.project.name}  [${run.profile}]`);
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

  // Counted, not subtracted. `total - failed` called every undetermined check a pass, which is the
  // arithmetic version of the same false green.
  const provedChecks = run.checks.filter((c) => c.status === Verified.YES).length;
  if (run.checks.length > 0) {
    out.push('', `Checks: ${provedChecks}/${run.checks.length} proved`);
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
