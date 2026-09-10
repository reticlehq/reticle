/**
 * A config that says "not here" is not an invitation to write into it.
 *
 * Reported from a monorepo audit: `init` added the plugin to an app whose `vite.config` carried a
 * comment saying Reticle was deliberately excluded. In the same run it appended to `CLAUDE.md`, the
 * file every agent in that repo reads first, and the reporter reverted all of it.
 *
 * Consent is the whole point. `init` runs unattended, usually by an agent, in a repo it has just
 * met. A tool that overrides an explicit "no" is one nobody lets near a monorepo twice — and a
 * silent override is worse than a refusal, because the file it edited is the file that said not to.
 *
 * `@reticle-ignore` is the marker, matching the convention proposed for source files, so a user
 * learns one thing rather than one per surface. Honouring it is deliberately NOT a failure: the
 * app is opted out on purpose, so the step reports as a notice rather than a ⚠ that reads as
 * something to go and fix.
 */

import { describe, expect, it } from 'vitest';
import { hasOptOut, OPT_OUT_MARKER } from './init-opt-out.js';
import { viteSteps } from './plan-framework.js';
import { StepStatus } from './plan.js';

describe('an explicit opt-out in a file init would edit', () => {
  it('is found in a line comment', () => {
    expect(hasOptOut('// @reticle-ignore — this app is verified upstream\nexport default {}')).toBe(
      true,
    );
  });

  it('is found in a block comment', () => {
    expect(hasOptOut('/* @reticle-ignore */\nexport default {}')).toBe(true);
  });

  it('is found in a hash comment, for the configs that use them', () => {
    expect(hasOptOut('# @reticle-ignore\nplugins: []')).toBe(true);
  });

  it('is absent from an ordinary config', () => {
    expect(hasOptOut('export default { plugins: [react()] }')).toBe(false);
  });

  it('does not fire on the word appearing in unrelated prose', () => {
    // "ignore" and "reticle" both appear in plenty of files. The marker is the exact token.
    expect(hasOptOut('// reticle can ignore this file eventually')).toBe(false);
    expect(hasOptOut('// see docs on @reticle-ignored-paths')).toBe(false);
  });

  it('is case-insensitive, because a marker people type by hand is typed how they like', () => {
    expect(hasOptOut('// @Reticle-Ignore')).toBe(true);
  });

  it('exports the marker so nothing has to restate the string', () => {
    expect(OPT_OUT_MARKER).toBe('@reticle-ignore');
  });

  it('handles an empty or absent file without throwing', () => {
    expect(hasOptOut('')).toBe(false);
    expect(hasOptOut(undefined)).toBe(false);
  });
});

/**
 * Honouring it, where it matters most: the config `init` would rewrite.
 *
 * Reported as an override of an explicit exclusion, so the assertion is that nothing is written AND
 * that the reason is said out loud. Silence would leave a user wondering whether the marker worked.
 */
describe('the vite step honours an opted-out config', () => {
  const input = (source: string): Parameters<typeof viteSteps>[0] =>
    ({
      viteConfig: { path: 'vite.config.ts', source },
      options: { port: 4400 },
      detection: { uiLibrary: undefined },
      captureBodies: false,
    }) as unknown as Parameters<typeof viteSteps>[0];

  it('writes nothing when the config opts out', () => {
    const step = viteSteps(input('// @reticle-ignore\nexport default { plugins: [] }'))[0];
    expect(step?.status).toBe(StepStatus.NOTICE);
    expect(step?.write, 'an opted-out config must not be rewritten').toBeUndefined();
  });

  it('says WHY, naming the marker, so the user knows it was read', () => {
    const step = viteSteps(input('// @reticle-ignore\nexport default { plugins: [] }'))[0];
    expect(step?.detail).toContain(OPT_OUT_MARKER);
  });

  it('is a NOTICE, not a manual step — opting out is not something to go and fix', () => {
    const step = viteSteps(input('/* @reticle-ignore */\nexport default {}'))[0];
    expect(step?.status).not.toBe(StepStatus.MANUAL);
  });

  it('still wires a config that says nothing', () => {
    const step = viteSteps(input('export default { plugins: [] }'))[0];
    expect(step?.status).not.toBe(StepStatus.NOTICE);
  });
});
