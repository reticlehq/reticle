/**
 * Risk-rank flows so an agent tests the riskiest first. Risk combines two signals:
 *  - run history (.iris/project.json): a flow whose last run errored/drifted, or passed but with
 *    console/network errors, is riskier than one that passed clean; a never-run flow is unknown.
 *  - assertion quality (flow-classify): a flow that asserts no consequence is risky EVEN when it
 *    "passes" — a green assertion-free flow is false confidence (Fowler/Dodds), so it can't be
 *    trusted to catch a regression.
 *
 * Taking the worse of the two means "passed clean last time" never hides "but it asserts nothing".
 * Pure: no IO, no clock.
 */

import { RunStatus, type RunRecord } from '@syrin/iris-protocol';
import { FlowAssertionGrade } from '../flows/flow-classify.js';

export const RiskLevel = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'unknown',
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

// Test-priority order: a known failure first, then a known weakness, then a NEVER-RUN flow
// (unvalidated — worth running before a known-clean one), then a clean low-risk flow last.
const RANK: Record<RiskLevel, number> = {
  [RiskLevel.HIGH]: 3,
  [RiskLevel.MEDIUM]: 2,
  [RiskLevel.UNKNOWN]: 1,
  [RiskLevel.LOW]: 0,
};

export interface FlowRisk {
  level: RiskLevel;
  reason: string;
  lastStatus?: RunStatus;
}

/** Most recent run for a flow name (by `at`), or undefined if it has never been recorded. */
export function latestRun(name: string, runs: readonly RunRecord[]): RunRecord | undefined {
  let best: RunRecord | undefined;
  for (const run of runs) {
    if (run.name === name && (best === undefined || run.at > best.at)) best = run;
  }
  return best;
}

function runRisk(run: RunRecord | undefined): { level: RiskLevel; reason: string } {
  if (run === undefined) return { level: RiskLevel.UNKNOWN, reason: 'never run' };
  if (run.status === RunStatus.ERROR || run.status === RunStatus.FAIL) {
    return { level: RiskLevel.HIGH, reason: 'last run failed' };
  }
  if (run.status === RunStatus.DRIFT) return { level: RiskLevel.HIGH, reason: 'last run drifted' };
  const errors = (run.evidence?.consoleErrors ?? 0) + (run.evidence?.networkErrors ?? 0);
  if (errors > 0) {
    return {
      level: RiskLevel.MEDIUM,
      reason: `last run passed but logged ${String(errors)} error(s)`,
    };
  }
  return { level: RiskLevel.LOW, reason: 'last run passed clean' };
}

function gradeRisk(grade: string): { level: RiskLevel; reason: string } {
  if (grade === FlowAssertionGrade.ASSERTION_FREE) {
    return {
      level: RiskLevel.MEDIUM,
      reason: 'asserts no consequence — a green run proves little',
    };
  }
  if (grade === FlowAssertionGrade.PRESENCE_ONLY) {
    return { level: RiskLevel.LOW, reason: 'presence-only assertion' };
  }
  return { level: RiskLevel.LOW, reason: 'asserts a consequence' };
}

/** The worse of run-history risk and assertion-quality risk. */
export function flowRisk(grade: string, run: RunRecord | undefined): FlowRisk {
  const r = runRisk(run);
  const g = gradeRisk(grade);
  const top = RANK[r.level] >= RANK[g.level] ? r : g;
  return run === undefined
    ? { level: top.level, reason: top.reason }
    : { level: top.level, reason: top.reason, lastStatus: run.status };
}

/** Order flow names worst-risk first (HIGH→UNKNOWN), ties broken by name for stable output. */
export function rankByRisk(entries: { name: string; risk: FlowRisk }[]): string[] {
  return [...entries]
    .sort((a, b) => RANK[b.risk.level] - RANK[a.risk.level] || a.name.localeCompare(b.name))
    .map((e) => e.name);
}
