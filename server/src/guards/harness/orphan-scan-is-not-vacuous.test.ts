import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPackage } from '../../../../scripts/orphan-scan.mjs';

/**
 * The scanner ten guards trust, and which nothing tested.
 *
 * `orphan-modules.test.ts` exists ten times — once per package — and every copy asserts the
 * same two things: that the orphan list is empty and the stale list is empty. None of them
 * asserts that anything was scanned. All ten delegate to one `scanPackage`, and that function
 * had no test at all, so the single point every one of them depends on was the one piece of
 * the arrangement nobody checked.
 *
 * A missing `src` already threw from `readdirSync`, loudly, which is why this was never
 * noticed. The quiet half is a `src` that EXISTS and yields no source: a renamed layout, a
 * changed extension, a filter that stops matching. That produced `{orphans: [], stale: []}` and
 * turned all ten green while checking nothing — measured, before the guard below existed.
 *
 * The fix lives in `scanPackage` rather than in ten copies of an assertion, because the
 * eleventh package's guard would be written by copying the tenth, and the assertion is exactly
 * the kind of thing that does not get copied.
 */

describe('a scan that found nothing is an error, not a clean result', () => {
  it('refuses a package whose src exists but holds no source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orphan-scan-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'package.json'), '{}');
      // A file, so the directory is not empty -- the failure being guarded is "nothing MATCHED",
      // which is quieter than "nothing is there" and reads identically in the result.
      writeFileSync(join(dir, 'src', 'README.md'), 'not source');
      expect(() => scanPackage(dir)).toThrow(/no source files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still scans a real package, so the guard above is not simply breaking it', () => {
    // The other half of the control. A throw-on-empty that throws on everything would satisfy
    // the expectation above and disable all ten guards, which is a worse outcome than the bug.
    const scanned = scanPackage(join(__dirname, '..', '..', '..', '..', 'openreality'));
    expect(scanned.entries.length).toBeGreaterThan(0);
  });
});
