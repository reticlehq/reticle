/**
 * `reticle_crawl { exhaustive: true }` — explore every reachable state, drive every write's failure
 * path and the edge cases of every state, take the code coverage, fold all of it into the ledger,
 * and say what is left.
 *
 * It answers in crawl's own shape, so every caller that reads a crawl keeps working, and adds one
 * `exhaustive` block with what only this mode knows.
 */

import { BehaviourFindingKind } from '@reticlehq/core';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  emptyCodeCoverage,
  foldCodeCoverage,
  type RawScriptCoverage,
} from '@/features/exhaust/code-coverage.js';
import { driveEdges } from '@/features/exhaust/edges/edge-drive.js';
import { explore, type ExploreReport } from '@/features/exhaust/explorer.js';
import { driveFailureBranches } from '@/features/exhaust/failure-branches.js';
import { failureFindings } from '@/features/exhaust/invariants.js';
import { LedgerStore, levelsOf, regressions } from '@/features/exhaust/ledger.js';
import { sessionPort, type PortSession } from '@/features/exhaust/session-port.js';

/** The share of a GIVEN budget kept back for failure paths, so exploring cannot starve them. */
const FAILURE_SHARE = 0.25;
/** The share of a GIVEN budget kept back for edge cases. What exploring leaves goes to them too. */
export const EDGE_SHARE = 0.25;

/**
 * With no budget given, each phase gets what the crawl found, up to a ceiling. Exploring stops on
 * its own when no state is left; the ceiling only bounds an app too large to finish. A fixed 400,
 * split by share, ran out on bench-app before the edge drive reached its third page.
 */
export const ExhaustBudget = {
  EXPLORE_CEILING: 600,
  /** A failure path replays the write's path, breaks it and fires it. */
  FAILURE_PER_WRITE: 12,
  FAILURE_CEILING: 150,
  /** Enough for the first few probes of one control, each a replay and a few presses. */
  EDGE_PER_CONTROL: 15,
  EDGE_CEILING: 450,
} as const;

/** The failure and edge budgets for what exploring found. */
export function scaledBudget(found: Pick<ExploreReport, 'surfaces' | 'writes'>): {
  failure: number;
  edges: number;
} {
  const controls = new Set(found.surfaces.flatMap((s) => [...s.requests, ...s.fields, ...s.inert]));
  return {
    failure: Math.min(
      ExhaustBudget.FAILURE_CEILING,
      ExhaustBudget.FAILURE_PER_WRITE * found.writes.length,
    ),
    edges: Math.min(ExhaustBudget.EDGE_CEILING, ExhaustBudget.EDGE_PER_CONTROL * controls.size),
  };
}

export async function runExhaustive(input: {
  sessions: { get(id: string): PortSession | undefined };
  session: PortSession;
  startUrl: string;
  /** A fixed budget, split by share. Absent: each phase gets what the crawl found (`scaledBudget`). */
  maxActions?: number;
  settleMs: number;
  /** What to type into a field, given the page it is on — a secret is only for its own origin. */
  fillValue: (label: string, pageUrl: string) => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setMocks?: (
    sessionUrl: string,
    rules: { urlContains: string; method?: string; abort?: boolean }[],
  ) => Promise<boolean>;
  takeCode?: (sessionUrl: string) => Promise<readonly RawScriptCoverage[] | undefined>;
  fs: FileSystemPort;
  reticleRoot: string;
}): Promise<Record<string, unknown>> {
  const port = sessionPort({
    sessions: input.sessions,
    start: input.session,
    startUrl: input.startUrl,
    settleMs: input.settleMs,
    now: input.now,
    sleep: input.sleep,
    ...(input.setMocks === undefined ? {} : { setMocks: input.setMocks }),
  });
  const given = input.maxActions;
  const exploreBudget =
    given === undefined
      ? ExhaustBudget.EXPLORE_CEILING
      : given - Math.floor(given * FAILURE_SHARE) - Math.floor(given * EDGE_SHARE);
  const report = await explore(port, {
    maxActions: exploreBudget,
    fillValue: (label) => input.fillValue(label, port.current().url),
  });
  const scaled = scaledBudget(report);
  const failureBudget = given === undefined ? scaled.failure : Math.floor(given * FAILURE_SHARE);
  const edgeBudget =
    given === undefined
      ? scaled.edges
      : Math.floor(given * EDGE_SHARE) + Math.max(0, exploreBudget - report.actions);
  const branches = await driveFailureBranches(port, report.writes, { maxActions: failureBudget });
  const edges = await driveEdges(port, report.surfaces, {
    maxActions: edgeBudget,
    now: input.now,
    known: report.anomalies.map((a) => `${a.control}\n${a.kind}`),
  });
  const take = await input.takeCode?.(port.current().url);
  const ledger = await new LedgerStore(input.fs, input.reticleRoot).merge({
    routes: { reached: report.routes },
    controls: { seen: report.seen, touched: report.touched },
    writes: {
      seen: report.writes.map((w) => w.key),
      branched: branches.branched,
      unhandled: branches.unhandled.map((u) => u.key),
    },
    edges: { probed: edges.probed },
    findings: [...failureFindings(branches, report.writes), ...edges.found.map((f) => f.finding)],
    ...(take === undefined
      ? {}
      : { code: foldCodeCoverage(emptyCodeCoverage(), take), codeTakenAt: input.now() }),
  });
  const anomalies = [
    ...report.anomalies.map((a) => ({ kind: a.kind, ref: '', desc: a.control, detail: a.detail })),
    ...branches.unhandled.map((u) => ({
      kind: BehaviourFindingKind.FAILURE_UNHANDLED,
      ref: '',
      desc: u.key,
      detail: u.detail,
    })),
    ...edges.found.map((f) => ({
      kind: f.finding.kind,
      ref: '',
      desc: f.control,
      detail: f.finding.detail,
      ...(f.finding.source === undefined ? {} : { source: f.finding.source }),
    })),
  ];
  const counts: Record<string, number> = {};
  for (const a of anomalies) {
    counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  }
  return {
    interactiveFound: report.seen.length,
    stepsRun: report.actions,
    anomalies,
    counts,
    visited: report.touched,
    truncated: report.frontier > 0 || report.budgetExhausted,
    exhaustive: {
      states: report.states,
      routes: report.routes,
      frontier: report.frontier,
      unreachable: report.unreachable,
      budgetExhausted: report.budgetExhausted,
      writes: report.writes.map((w) => w.key),
      failureBranches: branches,
      edges: {
        probed: edges.probed.length,
        findings: edges.found.length,
        actions: edges.actions,
        budgetExhausted: edges.budgetExhausted,
        ...(edges.failed > 0 ? { failed: edges.failed } : {}),
      },
      levels: levelsOf(ledger),
      regressed: regressions(ledger),
      ...(take === undefined
        ? {
            codeNote:
              'code coverage needs a browser Reticle drives (`reticle drive`, or RETICLE_CDP_URL)',
          }
        : {}),
    },
  };
}
