/**
 * `reticle_coverage { scope: "app" }` — fold this session into the ledger and say where "everything"
 * stands, level by level.
 */

import type { ReticleEvent } from '@reticlehq/core';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { emptyCodeCoverage, foldCodeCoverage, type RawScriptCoverage } from './code-coverage.js';
import { LedgerStore, levelsOf, regressions, type LevelReport } from './ledger.js';
import { sessionDelta } from './session-fold.js';

export interface AppCoverageReport {
  levels: LevelReport[];
  /** Writes whose failure path was driven and the app claimed success anyway. Findings, not gaps. */
  unhandledWrites: string[];
  /** Levels below the best they ever reached. */
  regressed: { level: string; was: number; now: number }[];
  note?: string;
}

const NO_CODE_NOTE =
  'The `executed` level is unmeasured here: code coverage needs a browser Reticle drives (`reticle drive`, or RETICLE_CDP_URL), and collection starts at the first coverage request, so drive and ask again. The other levels are real.';

export async function foldAppCoverage(input: {
  fs: FileSystemPort;
  reticleRoot: string;
  seen: readonly string[];
  session: {
    url: string;
    actedLabels(): ReadonlySet<string>;
    provedLabels?(): ReadonlySet<string>;
    eventsSince(cursor: number): ReticleEvent[];
  };
  takeCode?: (sessionUrl: string) => Promise<readonly RawScriptCoverage[] | undefined>;
}): Promise<AppCoverageReport> {
  const { session } = input;
  const take = await input.takeCode?.(session.url);
  const delta = sessionDelta({
    seen: input.seen,
    acted: session.actedLabels(),
    proved: session.provedLabels?.() ?? [],
    url: session.url,
    events: session.eventsSince(0),
  });
  const ledger = await new LedgerStore(input.fs, input.reticleRoot).merge({
    ...delta,
    ...(take === undefined ? {} : { code: foldCodeCoverage(emptyCodeCoverage(), take) }),
  });
  return {
    levels: levelsOf(ledger),
    unhandledWrites: ledger.writes.unhandled,
    regressed: regressions(ledger),
    ...(take === undefined && 0 === Object.keys(ledger.code).length ? { note: NO_CODE_NOTE } : {}),
  };
}
