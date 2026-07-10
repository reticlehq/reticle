/**
 * Build a compact "domain model" of an app's testable surface for an agent to read BEFORE testing:
 * the demonstrated flows, what each one actually asserts, and — the differentiator — the GAPS
 * between declared intent (capabilities the app registered: signals/testids) and what any flow
 * actually verifies.
 *
 * Why (grounded): automation "checks the DOM, not the intent" — tests pass while real,
 * integrated-system bugs ship (Bolton; Fowler Assertion-Free Testing). An agent that can see "you
 * declared the signal order:placed but no flow asserts it" knows where the real risk is, instead of
 * re-deriving the app's flows by reading all the source. Pairs with the flow assertion grades
 * (flow-classify) so "rigorous" and "domain-aware" reinforce each other.
 *
 * Pure: no IO, no clock. The tool layer loads flows + contract and calls this.
 */

import {
  AnchorKind,
  type CapabilitiesContract,
  type FlowFile,
  type FlowStep,
  type RunRecord,
} from '@reticlehq/core';
import { classifyFlowAssertions, FlowAssertionGrade } from '../flows/flow-classify.js';
import { successLabel } from '../flows/flow-success.js';
import { flowRisk, latestRun, rankByRisk, RiskLevel, type FlowRisk } from './flow-risk.js';

export interface DomainFlowSummary {
  name: string;
  steps: number;
  grade: string;
  /** True when the flow asserts a real consequence (signal/net), not just presence. */
  asserts: boolean;
  /**
   * The success consequence that MUST hold for this flow to count as passing — the human-readable
   * label of flow.success (e.g. a signal name or net URL). Undefined when the flow declares no
   * success condition (then `asserts` is false: it tests nothing observable). This is the
   * "what must hold for each flow" an agent needs before testing.
   */
  mustHold?: string;
  warning?: string;
  signals: string[];
  testids: string[];
  /** Combined run-history + assertion-quality risk (present when run history is supplied). */
  risk?: FlowRisk;
}

export interface DomainGaps {
  /** Flows that act but don't assert a consequence (grade !== asserted). */
  unassertedFlows: string[];
  /** Signals the app declared in capabilities that NO flow asserts — untested intent. */
  declaredUntestedSignals: string[];
  /** Testids the app declared that no saved flow exercises. */
  declaredUntestedTestids: string[];
}

export interface DomainModel {
  flowCount: number;
  flows: DomainFlowSummary[];
  declared: { testids: number; signals: string[]; stores: string[] };
  coverage: { asserted: number; presenceOnly: number; assertionFree: number };
  gaps: DomainGaps;
  /** Flow names worst-risk first (run-history + assertion quality). Empty without run history. */
  riskRanked: string[];
  /** One-line headline an agent (or human) can read at a glance. */
  summary: string;
}

function flatten(steps: readonly FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  for (const s of steps) {
    out.push(s);
    if (s.steps !== undefined) out.push(...flatten(s.steps));
  }
  return out;
}

function flowSignals(flow: FlowFile): string[] {
  const set = new Set<string>();
  for (const step of flatten(flow.steps)) {
    if (step.anchor.kind === AnchorKind.SIGNAL) set.add(step.anchor.name);
    if (step.expect?.signal !== undefined) set.add(step.expect.signal);
  }
  if (flow.success?.signal !== undefined) set.add(flow.success.signal);
  return [...set];
}

function flowTestids(flow: FlowFile): string[] {
  const set = new Set<string>();
  for (const step of flatten(flow.steps)) {
    if (step.anchor.kind === AnchorKind.TESTID) set.add(step.anchor.value);
    if (step.expect?.element?.testid !== undefined) set.add(step.expect.element.testid);
  }
  if (flow.success?.element?.testid !== undefined) set.add(flow.success.element.testid);
  return [...set];
}

const EMPTY_CONTRACT: CapabilitiesContract = { testids: [], signals: [], stores: [], flows: [] };

export function buildDomainModel(
  flows: readonly FlowFile[],
  contract: CapabilitiesContract | null,
  runs: readonly RunRecord[] = [],
): DomainModel {
  const caps = contract ?? EMPTY_CONTRACT;
  const hasHistory = runs.length > 0;

  const flowSummaries: DomainFlowSummary[] = flows.map((flow) => {
    const c = classifyFlowAssertions(flow);
    const summary: DomainFlowSummary = {
      name: flow.name,
      steps: c.totalSteps,
      grade: c.grade,
      asserts: c.hasConsequenceAssertion,
      signals: flowSignals(flow),
      testids: flowTestids(flow),
    };
    if (flow.success !== undefined) summary.mustHold = successLabel(flow.success);
    if (c.warning !== undefined) summary.warning = c.warning;
    if (hasHistory) summary.risk = flowRisk(c.grade, latestRun(flow.name, runs));
    return summary;
  });

  const testedSignals = new Set(flowSummaries.flatMap((f) => f.signals));
  const testedTestids = new Set(flowSummaries.flatMap((f) => f.testids));

  const coverage = {
    asserted: flowSummaries.filter((f) => f.grade === FlowAssertionGrade.ASSERTED).length,
    presenceOnly: flowSummaries.filter((f) => f.grade === FlowAssertionGrade.PRESENCE_ONLY).length,
    assertionFree: flowSummaries.filter((f) => f.grade === FlowAssertionGrade.ASSERTION_FREE)
      .length,
  };

  const gaps: DomainGaps = {
    unassertedFlows: flowSummaries.filter((f) => !f.asserts).map((f) => f.name),
    declaredUntestedSignals: caps.signals.filter((s) => !testedSignals.has(s)),
    declaredUntestedTestids: caps.testids.filter((t) => !testedTestids.has(t)),
  };

  const riskRanked = hasHistory
    ? rankByRisk(
        flowSummaries
          .filter((f) => f.risk !== undefined)
          .map((f) => ({ name: f.name, risk: f.risk as FlowRisk })),
      )
    : [];

  // The most actionable fact — the riskiest flow to test first — when run history flagged one.
  const top = riskRanked[0];
  const topFlow = top === undefined ? undefined : flowSummaries.find((f) => f.name === top);
  const topRisk =
    topFlow?.risk !== undefined &&
    (topFlow.risk.level === RiskLevel.HIGH || topFlow.risk.level === RiskLevel.MEDIUM)
      ? { name: topFlow.name, reason: topFlow.risk.reason }
      : undefined;

  return {
    flowCount: flows.length,
    flows: flowSummaries,
    declared: { testids: caps.testids.length, signals: caps.signals, stores: caps.stores },
    coverage,
    gaps,
    riskRanked,
    summary: buildSummary(flows.length, coverage, gaps, topRisk),
  };
}

function buildSummary(
  flowCount: number,
  coverage: DomainModel['coverage'],
  gaps: DomainGaps,
  topRisk: { name: string; reason: string } | undefined,
): string {
  if (flowCount === 0) {
    return 'No saved flows yet — record the critical journeys (reticle_record_start) so the agent learns the app.';
  }
  const parts = [
    `${String(flowCount)} flow${flowCount === 1 ? '' : 's'}: ${String(coverage.asserted)} asserted, ${String(coverage.presenceOnly)} presence-only, ${String(coverage.assertionFree)} assertion-free`,
  ];
  if (topRisk !== undefined) {
    parts.push(`test first: ${topRisk.name} (${topRisk.reason})`);
  }
  if (gaps.declaredUntestedSignals.length > 0) {
    parts.push(
      `${String(gaps.declaredUntestedSignals.length)} declared signal(s) no flow asserts (${gaps.declaredUntestedSignals.join(', ')})`,
    );
  }
  if (gaps.unassertedFlows.length > 0) {
    parts.push(`${String(gaps.unassertedFlows.length)} flow(s) assert no consequence`);
  }
  return parts.join('. ') + '.';
}
