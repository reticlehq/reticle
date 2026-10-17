/**
 * The `prettierIgnoreStep` in the init plan: when the project uses Prettier, `init` adds
 * `.reticle/` to the project's `.prettierignore` so `prettier --check .` stays green (#1560).
 */

import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager, UiLibrary, type Detection } from '@/detect/detect.js';

function detection(usesPrettier = true): Detection {
  return {
    framework: Framework.VITE,
    uiLibrary: UiLibrary.REACT,
    typescript: true,
    reactMajor: 19,
    needsSourceMapping: true,
    packageManager: PackageManager.PNPM,
    usesPrettier,
  };
}

function input(partial: Partial<PlanInput>): PlanInput {
  return {
    detection: partial.detection ?? detection(),
    claudeCli: false,
    mcpExists: false,
    nextConfigFile: null,
    viteConfig: null,
    nextReticleDevExists: false,
    ...(partial.prettierIgnoreSource === undefined
      ? {}
      : { prettierIgnoreSource: partial.prettierIgnoreSource }),
    options: partial.options ?? { port: undefined, mcp: false, install: false },
  };
}

describe('the Prettier ignore step', () => {
  const STEP_TITLE = 'Prettier ignore';

  function prettierInput(partial: Partial<PlanInput> = {}) {
    return input({
      detection: detection(true),
      prettierIgnoreSource: null,
      ...partial,
    });
  }

  it('is absent when the project does not use Prettier', () => {
    const plan = buildPlan(prettierInput({ detection: detection(false) }));
    expect(plan.steps.some((s) => s.title === STEP_TITLE)).toBe(false);
  });

  it('creates .prettierignore when the project uses Prettier and has none', () => {
    const plan = buildPlan(prettierInput());
    const step = plan.steps.find((s) => s.title === STEP_TITLE);
    expect(step?.status).toBe(StepStatus.APPLY);
    expect(step?.write?.path).toBe('.prettierignore');
    expect(step?.write?.content).toContain('.reticle/');
  });

  it('appends to an existing .prettierignore that lacks the entry', () => {
    const plan = buildPlan(prettierInput({ prettierIgnoreSource: 'node_modules/\n' }));
    const step = plan.steps.find((s) => s.title === STEP_TITLE);
    expect(step?.status).toBe(StepStatus.APPLY);
    expect(step?.write?.content).toContain('node_modules/');
    expect(step?.write?.content).toContain('.reticle/');
  });

  it('is ALREADY when .reticle/ is already excluded', () => {
    const plan = buildPlan(prettierInput({ prettierIgnoreSource: '.reticle/\n' }));
    const step = plan.steps.find((s) => s.title === STEP_TITLE);
    expect(step?.status).toBe(StepStatus.ALREADY);
  });

  it('detects Prettier via the usesPrettier flag', () => {
    const plan = buildPlan(prettierInput({ detection: detection(true) }));
    expect(plan.steps.some((s) => s.title === STEP_TITLE)).toBe(true);
  });
});
