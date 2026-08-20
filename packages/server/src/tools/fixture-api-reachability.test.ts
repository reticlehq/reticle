import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No bench-app source may fetch a RELATIVE `/api/...` URL.
 *
 * bench-app has no Vite dev-server proxy, so a relative API path never reaches `apps/api` on :8787.
 * It hits the dev server, matches nothing, and comes back as the SPA fallback: `index.html` with
 * **status 200**. The request does not error. It succeeds, with the wrong body, silently.
 *
 * That is not hypothetical. `Hostile.tsx` fired `fetch('/api/broken/500')` behind a button labelled
 * "Fire failing request", and the fixture's own docstring named the acceptance it exists to prove:
 *
 *     "the single failed request must survive the flood instead of being pushed out of the
 *      ring buffer by thousands of low-signal churn events"
 *
 * There was no failed request. The flood was being tested against a 200, so the acceptance was
 * exercising a weaker claim than the one written down — and priority eviction exists specifically
 * to protect FAILURES, which is the case that was never run. Every other call site in bench-app
 * already used `API_BASE`; this one was the outlier, and nothing could see it, because a 200 is
 * exactly what a passing test looks like.
 *
 * Placed in the unit gate rather than the e2e battery for the same reason as
 * `e2e-surface-drift.test.ts`: the battery needs three servers and minutes, this needs a substring,
 * and the pattern in this repo is unambiguous — every rule a machine enforces has held, and every
 * rule left to prose has been violated.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SRC = join(REPO, 'apps', 'bench-app', 'src');

/**
 * `fetch('/api/…')` in any quote style — the shape that silently resolves to the SPA fallback.
 *
 * NOT global. `.test()` on a `/g` regex advances `lastIndex` and resumes from there on the next
 * call, so once one file matched, the following file was searched from an offset into a string it
 * has nothing to do with — and a second offender was skipped. A guard that stops catching things
 * after its first hit is worse than no guard, because the green is now evidence of nothing.
 */
const RELATIVE_API_FETCH = /fetch\(\s*['"`]\/api\//;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('bench-app requests reach the API', () => {
  it('no source fetches a relative /api/ path — there is no dev-server proxy', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => RELATIVE_API_FETCH.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO, file));
    expect(offenders).toEqual([]);
  });

  it('the guard actually matches the shape it is meant to catch', () => {
    // Without this, a broken regex makes the check above pass forever while enforcing nothing —
    // which is the exact failure it was written to prevent, one level up.
    //
    // Against the REAL constant, not a copy of it pasted here: a self-test that retypes the pattern
    // proves the pattern in the test file, and goes on passing while the one actually used drifts.
    expect(RELATIVE_API_FETCH.test("void fetch('/api/broken/500')")).toBe(true);
    expect(RELATIVE_API_FETCH.test('await fetch(`${API_BASE}/api/broken/500`)')).toBe(false);
  });

  it('finds a second offender, not just the first', () => {
    // The `/g` + `.test()` bug this pins: a stateful regex carries `lastIndex` between calls, so the
    // scan above went blind to every file after the first match. Two identical strings in a row is
    // the whole reproduction.
    const offender = "void fetch('/api/broken/500')";
    expect(RELATIVE_API_FETCH.test(offender)).toBe(true);
    expect(
      RELATIVE_API_FETCH.test(offender),
      'the guard must not go blind after its first hit',
    ).toBe(true);
  });
});
