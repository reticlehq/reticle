/**
 * Telling somebody to install a plugin they already have, because they turned an option off.
 *
 * From a field session against a react-three-fiber app. `sourceMapping` stamps `data-reticle-source`
 * on JSX host elements, R3F's host elements are three.js objects, and the stamp crashed the whole
 * app to a white screen — so the reporter disabled the option, deliberately and correctly. Every
 * later red verdict then carried `no-source-mapping`, whose remedy is "add the build plugin", which
 * was already there and whose stamp was the thing that broke the app.
 *
 * This matters more now than when it was reported: `reticle init` writes `sourceMapping: false` on
 * its own for any app whose manifest names a non-DOM reconciler, so every three.js user reaches this
 * gap by default. A remedy that cannot be followed is worse than silence — it costs a round trip and
 * teaches the reader to skip the gap block, which is where the honest gaps live too.
 *
 * The fix follows `captureBodies` exactly: the plugin knows the option at config time, the page
 * announces it in HELLO, and the gap reports a CHOICE instead of an omission.
 */
import { describe, expect, it } from 'vitest';
import { InstrumentationGapKind } from '@reticlehq/core';
import { gapsForAction } from './instrumentation-gaps.js';

const RED = { pass: false, ref: 'e1' } as const;

const gapFor = (facts: Record<string, unknown>): string | undefined => {
  const found = gapsForAction({ ...RED, ...facts } as never).find(
    (g) =>
      g.kind === InstrumentationGapKind.NO_SOURCE_MAPPING ||
      g.kind === InstrumentationGapKind.SOURCE_MAPPING_OFF,
  );
  return found === undefined ? undefined : `${found.missing} ${found.cost} ${found.fix}`;
};

describe('a red verdict with no source pointer', () => {
  it('still asks for the build plugin when nobody said otherwise', () => {
    // The ordinary case, unchanged: an app that simply has no source mapping set up.
    expect(gapFor({ source: undefined })).toBeDefined();
  });

  it('says nothing at all when the verdict DID carry a source pointer', () => {
    expect(gapFor({ source: 'src/App.tsx:12:4' })).toBeUndefined();
  });

  it('names the CHOICE when the page said source mapping is off on purpose', () => {
    const gap = gapFor({ source: undefined, sourceMappingDisabled: true });
    expect(gap).toBeDefined();
    expect(gap).toMatch(/off|disabled|turned/i);
  });

  it('does not tell that reader to add a plugin they already have', () => {
    // The exact remedy the reporter could not follow, and the one this kind exists to replace.
    const gap = gapFor({ source: undefined, sourceMappingDisabled: true }) ?? '';
    expect(gap).not.toContain('add the Reticle build plugin');
    expect(gap).toMatch(/nothing to install/i);
  });

  it('names why turning it back on may not be an option', () => {
    // A remedy that says only "re-enable it" would send a three.js app straight back to the white
    // screen that made them turn it off.
    expect(gapFor({ source: undefined, sourceMappingDisabled: true })).toMatch(
      /react-three-fiber/i,
    );
  });

  it('treats an SDK that says nothing as the ordinary case, never as an opt-out', () => {
    // Absent means UNKNOWN. Reading silence as "deliberately off" would suppress the honest gap for
    // every app on an older SDK, which is the same silent loss one step further along.
    expect(gapFor({ source: undefined, sourceMappingDisabled: undefined })).toMatch(
      /source mapping/i,
    );
  });
});
