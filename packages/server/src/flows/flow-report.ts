import {
  ReplayStatus,
  type FlowFile,
  type FlowReplayResult,
  type FlowStepResult,
} from '@syrin/iris-protocol';
import { classifyFlowAssertions } from './flow-classify.js';

/**
 * Render a HUMAN-facing confidence report for a replayed flow — the artifact a developer reads to
 * trust the test without re-running it. It answers the three confidence questions in one page:
 *   WHY    — the declared business intent (+ whether it is actually asserted).
 *   WHAT   — the journey: a mermaid flow diagram + a per-step page → action → consequence table.
 *   PROOF  — the verdict (pass/drift/fail), the observed evidence (signals/network), and the
 *            measured cost (deterministic replay tokens vs an LLM re-drive).
 *
 * Pure: no IO, no clock. Markdown out (mermaid is the one place mermaid earns its tokens — a human
 * renders it). Token figures are passed in (measured by the caller), never faked.
 */

export interface FlowReportInput {
  flow: FlowFile;
  replay: FlowReplayResult;
  /** Measured deterministic replay cost (o200k proxy), for the "PROOF / cost" line. Optional. */
  replayTokens?: number;
  /** Measured per-run LLM re-drive cost of a step-driving tool, for the ratio. Optional. */
  competitorTokens?: number;
}

const VERDICT_GLYPH: Record<string, string> = {
  [ReplayStatus.OK]: '✅ pass',
  [ReplayStatus.DRIFT]: '⚠️ drift',
  [ReplayStatus.ERROR]: '❌ fail',
};

/** A mermaid-safe node id (mermaid ids must be alnum/underscore). */
function nodeId(index: number): string {
  return `s${index}`;
}

/** Escape a label for a mermaid `["..."]` node (quotes/newlines break the parser). */
function mermaidLabel(text: string): string {
  return text.replace(/"/g, "'").replace(/\n/g, ' ').slice(0, 80);
}

/** A short action verb for a step row ("act" is the tool; the anchor carries the target). */
function stepAction(step: FlowStepResult): string {
  return step.tool === 'success' ? 'assert outcome' : step.anchor;
}

/** The mermaid flowchart of the journey: one node per step, page-labelled, consequence on the edge. */
function mermaidDiagram(steps: FlowStepResult[]): string {
  const lines = ['```mermaid', 'flowchart TD'];
  steps.forEach((step, i) => {
    const page = step.page !== undefined ? `${step.page} — ` : '';
    const glyph = step.ok ? '' : ' ✗';
    lines.push(`  ${nodeId(i)}["${mermaidLabel(`${page}${stepAction(step)}${glyph}`)}"]`);
    if (i > 0) {
      const edge = steps[i - 1]?.consequence;
      const label = edge !== undefined ? `|"${mermaidLabel(edge)}"|` : '';
      lines.push(`  ${nodeId(i - 1)} -->${label} ${nodeId(i)}`);
    }
  });
  lines.push('```');
  return lines.join('\n');
}

/** The per-step journey table (page → action → consequence → result). */
function journeyTable(steps: FlowStepResult[]): string {
  const rows = [
    '| # | page | action | consequence | result |',
    '|---|------|--------|-------------|--------|',
  ];
  for (const step of steps) {
    const page = step.page ?? '—';
    const consequence = step.consequence ?? '—';
    const result = step.ok
      ? 'ok'
      : step.drift !== undefined
        ? `drift (${step.drift.anchor})`
        : 'fail';
    rows.push(`| ${step.step} | ${page} | ${stepAction(step)} | ${consequence} | ${result} |`);
  }
  return rows.join('\n');
}

/** Distinct observed consequences across the journey — the evidence the verdict rests on. */
function evidenceList(steps: FlowStepResult[]): string {
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.consequence !== undefined) {
      for (const part of step.consequence.split(';')) seen.add(part.trim());
    }
  }
  if (seen.size === 0) return '_No observable consequence captured._';
  return [...seen].map((e) => `- ${e}`).join('\n');
}

export function buildFlowReport(input: FlowReportInput): string {
  const { flow, replay, replayTokens, competitorTokens } = input;
  const grade = classifyFlowAssertions(flow);
  const verdict = VERDICT_GLYPH[replay.status] ?? replay.status;
  const intent = flow.intent ?? '_(no intent declared)_';
  const intentLine =
    flow.intent !== undefined
      ? grade.intentVerified
        ? `**Intent:** ${flow.intent} — **verified** (an observable outcome is asserted).`
        : `**Intent:** ${flow.intent} — ⚠️ declared but NOT asserted (add a consequence oracle).`
      : `**Intent:** ${intent}`;

  const out: string[] = [];
  out.push(`# Flow report — \`${flow.name}\``);
  out.push('');
  out.push(intentLine);
  out.push(`**Verdict:** ${verdict}  ·  **steps:** ${replay.steps.length}`);
  if (replayTokens !== undefined) {
    const ratio =
      competitorTokens !== undefined && replayTokens > 0
        ? `  ·  **${Math.round(competitorTokens / replayTokens)}×** cheaper than an LLM re-drive`
        : '';
    out.push(`**Cost:** ${replayTokens} tokens (deterministic replay, no LLM)${ratio}`);
  }
  if (replay.decision !== undefined) {
    out.push('');
    out.push(`> **Next action:** ${replay.decision.nextAction}`);
    if (replay.decision.whereInSource !== undefined) {
      out.push(`> **Where:** \`${replay.decision.whereInSource}\``);
    }
  }
  out.push('');
  out.push('## Journey');
  out.push(mermaidDiagram(replay.steps));
  out.push('');
  out.push(journeyTable(replay.steps));
  out.push('');
  out.push('## Evidence');
  out.push(evidenceList(replay.steps));
  out.push('');
  return out.join('\n');
}
