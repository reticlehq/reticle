import { STATUS_GLYPH, SUMMARY_FOOTER_PREFIX, TestStatus } from './constants.js';
import type { RunSummary, SpecResult } from './types.js';

export function summarize(results: readonly SpecResult[]): RunSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === TestStatus.PASS) passed += 1;
    else if (r.status === TestStatus.FAIL) failed += 1;
    else skipped += 1;
  }
  return { total: results.length, passed, failed, skipped, ok: failed === 0 };
}

function resultLine(r: SpecResult): string {
  const head = `${STATUS_GLYPH[r.status]} ${r.name} (${String(r.durationMs)}ms)`;
  if (r.skipReason !== undefined) return `${head} — ${r.skipReason}`;
  if (r.error !== undefined) return `${head} — ${r.error}`;
  return head;
}

/**
 * Write one line per spec plus a totals footer to the injected sink. NEVER references console
 * (no-console is an error); the CLI wrapper passes a stdout writer, tests pass a buffer collector.
 */
export function printSummary(
  summary: RunSummary,
  results: readonly SpecResult[],
  print: (line: string) => void,
): void {
  for (const r of results) print(resultLine(r));
  print(
    `${SUMMARY_FOOTER_PREFIX} ${String(summary.passed)} passed, ` +
      `${String(summary.failed)} failed, ${String(summary.skipped)} skipped`,
  );
}
