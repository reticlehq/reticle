/**
 * A framework nobody wired into the dispatch used to be installed as static HTML.
 *
 * `frameworkSteps` was an if/else chain whose final `else` emitted the plain-HTML manual snippet.
 * A member of `Framework` that no branch named therefore got `index.html` instructions, an
 * all-green report, and zero sessions — the exact shape of both the SvelteKit and the React Router
 * incidents, where detection landed the app somewhere the plan did not serve it.
 *
 * These tests are the runtime half of the guard. The compile-time half is the switch itself: every
 * case returns, so a new member makes the function lack an ending return and the build goes red.
 */

import { describe, expect, it } from 'vitest';
import { detect, Framework, type DetectInput } from '../detect/detect.js';
import { frameworkSteps } from './plan-framework.js';
import { STEP_TITLES, StepTitle } from './connect-steps.js';
import { type PlanInput, type Step } from './plan.js';

/** The target the plain-HTML fallback names, and the tell that a framework fell through to it. */
const HTML_INDEX = 'index.html';

const detectInput: DetectInput = {
  pkg: {},
  configFiles: new Set<string>(),
  lockfiles: new Set<string>(),
};

const planFor = (framework: Framework): PlanInput => ({
  detection: { ...detect(detectInput), framework },
  claudeCli: false,
  mcpExists: false,
  viteConfig: null,
  nextConfigFile: null,
  nextReticleDevExists: false,
  options: { port: 4400, mcp: false, install: true, projectId: 'demo' },
});

const isHtmlFallback = (step: Step): boolean =>
  step.title === StepTitle.CONNECT_SNIPPET && step.target === HTML_INDEX;

describe('every framework the detector can return', () => {
  it('plans something other than the plain-HTML manual snippet', () => {
    for (const framework of Object.values(Framework)) {
      if (framework === Framework.HTML) continue;
      const steps = frameworkSteps(planFor(framework));
      expect(steps.length, framework).toBeGreaterThan(0);
      expect(
        steps.some((s) => !isHtmlFallback(s)),
        `${framework} fell through to the plain-HTML path, so init would report green over an app that cannot connect`,
      ).toBe(true);
    }
  });

  it('still gives plain HTML the manual snippet, which is correct for it', () => {
    const steps = frameworkSteps(planFor(Framework.HTML));
    expect(steps.some(isHtmlFallback)).toBe(true);
  });
});

describe('the titles the plan emits', () => {
  /**
   * `connect-steps.ts` matches connect steps by TITLE. A rename here used to drop a step out of that
   * set silently, so `init` stopped failing on a ⚠ that guarantees no session. Every fixed title the
   * plan emits now comes from `StepTitle`, and this asserts none has drifted back to a free string.
   */
  it('all come from the shared StepTitle constants', () => {
    const known = new Set<string>(STEP_TITLES);
    for (const framework of Object.values(Framework)) {
      for (const step of frameworkSteps(planFor(framework))) {
        expect(known.has(step.title), `${framework}: ${step.title}`).toBe(true);
      }
    }
  });
});
