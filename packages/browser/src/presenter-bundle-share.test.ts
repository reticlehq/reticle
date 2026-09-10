import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How much of the SDK a user downloads is the HUD, and a ceiling on it.
 *
 * The presenter is the in-page panel: the thing that makes Reticle visible while an agent drives, and
 * the moment somebody first understands what the tool does. It earns its place in the product.
 *
 * It does not earn its place in every page load. It is nearly a third of the JavaScript this package
 * ships, and it is needed only once a bridge connects -- which, during ordinary development, is
 * almost never. Right now it is imported statically at the top of the SDK's entry, so a developer
 * whose page never connects to Reticle downloads all of it anyway.
 *
 * The fix is to load it when it is wanted rather than never to ship it, and that is a careful change
 * to the file everything else runs through. This is the ratchet in the meantime: it records what the
 * share is today and fails if it grows, so the case for doing the work does not quietly get worse
 * while the work is queued.
 *
 * A SHARE rather than a byte count, deliberately. An absolute ceiling would fail every time the rest
 * of the SDK grew, which is the wrong signal entirely -- and it would pass while the HUD doubled, as
 * long as everything else doubled too.
 */

const DIST = join(__dirname, '..', 'dist');

/** Bytes of shipped JavaScript under a directory. Type declarations and maps are not downloaded. */
function shippedBytes(dir: string): number {
  const out = execFileSync(
    'bash',
    ['-c', `find ${dir} -name '*.js' -exec cat {} + 2>/dev/null | wc -c`],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

/**
 * Measured 2026-09-10: 247,834 B of 838,749 B, which is 29.5%.
 *
 * Raising this needs a reason written here, the way the tool-surface budget does. Lowering it is the
 * point of the work it exists to motivate.
 */
const MAX_HUD_SHARE_PERCENT = 31;

describe('what share of the shipped SDK is the in-page HUD', () => {
  it('there is a build to measure', () => {
    // Without this the whole check passes on a missing directory, reporting a share of zero for a
    // package that was never built -- which reads as spectacular good news.
    expect(existsSync(join(DIST, 'presenter')), `${DIST} is missing — run pnpm build`).toBe(true);
  });

  it(`is at most ${String(MAX_HUD_SHARE_PERCENT)}% of the JavaScript a page downloads`, () => {
    const hud = shippedBytes(join(DIST, 'presenter'));
    const all = shippedBytes(DIST);
    expect(all, 'measured nothing — a broken find would read as an empty bundle').toBeGreaterThan(
      100_000,
    );
    expect(hud, 'measured no HUD — that would pass this check by accident').toBeGreaterThan(50_000);
    const share = Math.round((hud / all) * 100);
    expect(
      share,
      `the in-page HUD is ${String(share)}% of the shipped SDK (${String(hud)} B of ${String(all)} B). ` +
        'It is loaded on every page even when no agent ever connects. Either make it load lazily, or ' +
        'raise this ceiling here with the reason.',
    ).toBeLessThanOrEqual(MAX_HUD_SHARE_PERCENT);
  });
});
