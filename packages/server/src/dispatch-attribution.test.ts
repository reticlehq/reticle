import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * EVERY path that dispatches an ACT must open an attribution window around it.
 *
 * An unattributed effect is classified as ambient background churn, and the settle oracle drops
 * learned-ambient regions before deciding a page has settled. So a dispatch path that forgets
 * `beginAction` teaches the oracle to ignore the very regions the app reacts in, and a later
 * `{kind:"settled"}` returns settled while work is still in flight.
 *
 * The existing property test (action-attribution-ambient.test.ts) asserts the CLASSIFIER — that an
 * attributed event is not counted and an unattributed one is. A reviewer pointed out it therefore
 * cannot catch the thing that actually goes wrong: a call site that never opens a window. It only ever
 * calls `pushEvent` directly. That gap was real — three dispatch paths were fixed while `flow-replay`
 * and `replay` were missed, and those are the CI gate.
 *
 * This test scans source instead. It is deliberately crude: a file that dispatches ACT must also
 * mention `beginAction`. That cannot prove the window wraps the call correctly, but it does catch the
 * failure that has now happened twice — adding a dispatch path and forgetting attribution entirely.
 */

const SRC = join(__dirname);

/** Files that send an ACT/ACT_SEQUENCE command to the browser. */
const DISPATCHES_ACT = /ReticleCommand\.(ACT|ACT_SEQUENCE)\b/;
const OPENS_WINDOW = /beginAction/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    // Test harnesses are fixtures, not dispatch paths the product takes.
    if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test-harness.ts')
    ) {
      // `relative()` returns the PLATFORM separator, so every comparison below is against a POSIX
      // literal that never matches on Windows: the scan then reports every file as a violation, or
      // passes by matching nothing. Same fixture bug as four other packages on this branch.
      acc.push(relative(SRC, full).split(sep).join('/'));
    }
  }
  return acc;
}

/**
 * Files that reference the ACT command without dispatching it. Empty today — every referencing file is
 * a real dispatch path and every one opens a window. Kept as an explicit escape hatch so a future
 * non-dispatching reference must be justified here rather than silently weakening the scan.
 */
const NOT_A_DISPATCH_SITE = new Set<string>();

describe('every ACT dispatch path opens an attribution window', () => {
  it('no file sends an ACT without also calling beginAction', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !NOT_A_DISPATCH_SITE.has(f))
      .filter((f) => {
        const text = readFileSync(join(SRC, f), 'utf8');
        return DISPATCHES_ACT.test(text) && !OPENS_WINDOW.test(text);
      });
    expect(offenders).toEqual([]);
  });

  it('the scan actually finds the dispatch paths — it must not pass by matching nothing', () => {
    // A scan that silently matches zero files would pass forever. Assert it sees the real ones.
    const dispatchers = sourceFiles(SRC).filter((f) =>
      DISPATCHES_ACT.test(readFileSync(join(SRC, f), 'utf8')),
    );
    expect(dispatchers).toEqual(
      expect.arrayContaining([
        'tools/act-tools.ts',
        'crawl/crawl.ts',
        'flows/flow-replay.ts',
        'flows/replay.ts',
      ]),
    );
  });

  it('the exemption list contains only files that really do not dispatch', () => {
    for (const exempt of NOT_A_DISPATCH_SITE) {
      const text = readFileSync(join(SRC, exempt), 'utf8');
      expect(text).not.toMatch(/session\.command\(\s*ReticleCommand\.(ACT|ACT_SEQUENCE)/);
    }
  });
});
