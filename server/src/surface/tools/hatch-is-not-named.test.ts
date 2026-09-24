/**
 * No message routes an agent through `reticle_run` on a surface that does not carry it (#978).
 *
 * The default surface is MERGED, and MERGED is the one surface that deliberately omits the dispatch
 * hatch: `defaultAdvertisedNames` appends `reticle_run` for every surface except that one, with the
 * reason written beside it - "naming a hatch that is not there is the same defect one level in".
 *
 * The 3.1.0 release notes say exactly that, in Breaking, as something already fixed. It was fixed in
 * the places that ASK which surface is live - `dynamic-tools.ts` branches on it, `surface-vocabulary`
 * checks `advertised.has(ReticleTool.RUN)`. It was not fixed in the static message tables, which
 * cannot ask, and those are what an agent reads at the exact moment something has gone wrong.
 *
 * It costs twice over: `reticle_lease` is in no surface list and in no merged-name redirect, so on
 * the default surface it is unreachable, and the message sent the agent to it through a hatch that
 * is equally absent. Two dead ends in one sentence, at the point of failure.
 *
 * So these strings name only routes that work on EVERY surface: `reticle drive`, which needs no
 * tool at all, and the daemon restart that makes the tool advertised directly.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { RECOVERY } from './error-recovery.js';
import { defaultAdvertisedNames, TOOL_SURFACE, resolveToolSurface } from './tool-surface.js';

describe('the recovery messages and the dispatch hatch', () => {
  /* The premise. If the default surface ever carries the hatch again, this whole file is moot. */
  it('is a real problem: the default surface does not advertise it', () => {
    expect(resolveToolSurface()).toBe(TOOL_SURFACE.MERGED);
    expect(defaultAdvertisedNames()).not.toContain(ReticleTool.RUN);
  });

  it('never tells an agent to call a tool through it', () => {
    const naming = Object.entries(RECOVERY).filter(([, text]) =>
      String(text).includes(`${ReticleTool.RUN} {`),
    );
    expect(
      naming.map(([key]) => key),
      'these are read at the moment something failed, and they route through a tool that is not there',
    ).toEqual([]);
  });

  /* Taking the route away is only half of it — what replaces it has to actually work. */
  it('still offers a route that works with no tools advertised at all', () => {
    expect(RECOVERY.THROTTLED).toContain('reticle drive');
    expect(RECOVERY.HOVER_NEEDS_POINTER).toContain('reticle drive');
  });
});
