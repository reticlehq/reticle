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
import { explore } from '@/features/exhaust/explorer.js';
import { driveFailureBranches } from '@/features/exhaust/failure-branches.js';
import { failureFindings } from '@/features/exhaust/invariants.js';
import { LedgerStore, levelsOf, regressions } from '@/features/exhaust/ledger.js';
import { sessionPort, type PortSession } from '@/features/exhaust/session-port.js';

/** Default action budget: generous, because every edge replays its path from a fresh load. */
export const EXHAUST_DEFAULT_ACTIONS = 400;
/** The share of the budget kept back for failure paths, so exploring cannot starve them. */
const FAILURE_SHARE = 0.25;
/**
 * The share kept back for edge cases. Exploring keeps the rest, so edge cases cannot starve it; what
 * exploring leaves unspent goes to edge cases too.
 */
export const EDGE_SHARE = 0.25;

export async function runExhaustive(input: {
  sessions: { get(id: string): PortSession | undefined };
  session: PortSession;
  startUrl: string;
  maxActions: number;
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
  const failureBudget = Math.floor(input.maxActions * FAILURE_SHARE);
  const edgeBudget = Math.floor(input.maxActions * EDGE_SHARE);
  const exploreBudget = input.maxActions - failureBudget - edgeBudget;
  const report = await explore(port, {
    maxActions: exploreBudget,
    fillValue: (label) => input.fillValue(label, port.current().url),
  });
  const branches = await driveFailureBranches(port, report.writes, { maxActions: failureBudget });
  const edges = await driveEdges(port, report.surfaces, {
    maxActions: edgeBudget + Math.max(0, exploreBudget - report.actions),
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
