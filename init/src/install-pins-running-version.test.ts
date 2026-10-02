/**
 * The SDK `init` installs is the version of the server asking for it (#990).
 *
 * Reported on 3.1.0 release day, from three independent sessions: `reticle init` with a 3.1.0
 * server installed `@reticlehq/react@2.14.0` and `@reticlehq/next@2.14.0`. The page then never
 * dialled the bridge, `drive` reported a dial that failed authentication, and one session was
 * listed as `versionSkew unknown-vs-3.1.0` before the agent gave up on Reticle and used Playwright.
 *
 * What makes it worse than an ordinary skew is that `init` CREATES the condition the skew detector
 * exists to warn about, on a clean install, with no user error in it. The agent then follows
 * remediation advice for a problem the tool just caused.
 *
 * The two CDN paths that pin the same version already have this guard - `html-no-build.test.ts` and
 * `streamlit-snippet.test.ts` both assert `@${RETICLE_VERSION}` in the snippet they emit. The npm
 * install path, which is the one the field reported, was the only one of the three without it.
 *
 * The install gate cannot cover this: `version-skew-test.mjs` drives a FAKE SDK that lies about its
 * version, which answers "is the agent told when they differ", never "does a fresh install make
 * them differ".
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, frameworkPackages, type PlanInput } from './plan/plan.js';
import { Framework, PackageManager } from './detect/detect.js';
import { RETICLE_VERSION } from './version.js';

const installDetail = (framework: Framework): string => {
  const plan = buildPlan({
    detection: {
      framework,
      packageManager: PackageManager.NPM,
      hasReact: true,
      deps: {},
      dependencies: {},
    },
    claudeCli: true,
    mcpExists: true,
    viteConfig: null,
    nextConfigFile: null,
    nextConfigSource: null,
    options: { mcp: false, install: false, sdkVersion: RETICLE_VERSION },
  } as unknown as PlanInput);
  return plan.steps.find((s) => 'Install dependencies' === s.title)?.detail ?? '';
};

describe('the version init installs', () => {
  it('pins every package to the running release, for every framework it supports', () => {
    for (const framework of Object.values(Framework)) {
      const detail = installDetail(framework);
      const packages = frameworkPackages(framework, undefined);
      for (const name of packages) {
        expect(detail, `${framework}: ${name} must be pinned to ${RETICLE_VERSION}`).toContain(
          `${name}@${RETICLE_VERSION}`,
        );
      }
    }
  });

  /*
   * Non-vacuity. `toContain` over an empty package list passes about nothing, and the framework
   * enum is exactly the kind of thing that grows a member nobody wires up.
   */
  it('actually checked some packages', () => {
    const counted = Object.values(Framework).reduce(
      (n, f) => n + frameworkPackages(f, undefined).length,
      0,
    );
    expect(counted).toBeGreaterThan(0);
  });

  /* The version itself has to be a real release, not an empty string that would satisfy any pin. */
  it('is a real version', () => {
    expect(RETICLE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
