/**
 * A re-run over an already-wired project does no dependency work (#1068).
 *
 * Reported from the field: `init` in an already-instrumented npm-workspaces project "launched a
 * pnpm dependency migration, moved the existing node_modules to .ignored, and broke next dev".
 * `init` is documented as idempotent, and moving somebody's installed tree aside is not something a
 * scaffolder may do to a working checkout.
 *
 * Reproduced: with `@reticlehq/react` and `@reticlehq/next` ALREADY in devDependencies at the very
 * version init would pin, the plan still said `npm i -D @reticlehq/react@3.2.0 @reticlehq/next@3.2.0`.
 * That redundant install is the step that touches `node_modules`, so this is the destructive half's
 * mechanism whatever manager gets chosen.
 *
 * The caret is the whole reason it never noticed: `npm i -D pkg@3.2.0` WRITES `^3.2.0`, so on every
 * later run the pinned `3.2.0` fails a string comparison against the range it just created.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { Framework, PackageManager } from '@/detect/detect.js';

const INSTALL_STEP = 'Install dependencies';

const plan = (dependencies: Record<string, string>, sdkVersion = '3.2.0') =>
  buildPlan({
    detection: {
      framework: Framework.NEXT,
      packageManager: PackageManager.NPM,
      hasReact: true,
      deps: {},
      dependencies,
    },
    claudeCli: true,
    mcpExists: true,
    viteConfig: null,
    nextConfigFile: null,
    nextConfigSource: null,
    options: { mcp: false, install: true, sdkVersion },
  } as unknown as PlanInput);

const installStatus = (p: ReturnType<typeof buildPlan>) =>
  p.steps.find((s) => INSTALL_STEP === s.title)?.status;

describe('the install step on a project that already has the packages', () => {
  it('still installs when nothing is there — the first run must work', () => {
    expect(installStatus(plan({}))).toBe(StepStatus.APPLY);
  });

  it('does nothing when the exact pinned version is already declared', () => {
    expect(
      installStatus(plan({ '@reticlehq/react': '3.2.0', '@reticlehq/next': '3.2.0' })),
    ).toBe(StepStatus.ALREADY);
  });

  /* The shape npm itself writes after `npm i -D pkg@3.2.0`, and the one the field hit. */
  it('does nothing when the caret range npm wrote covers the pin', () => {
    expect(
      installStatus(plan({ '@reticlehq/react': '^3.2.0', '@reticlehq/next': '~3.2.0' })),
    ).toBe(StepStatus.ALREADY);
  });

  it('installs again when only SOME of the packages are there', () => {
    expect(installStatus(plan({ '@reticlehq/react': '^3.2.0' }))).toBe(StepStatus.APPLY);
  });

  /*
   * The safe direction. A false "already" leaves somebody with no SDK and an install that claims to
   * have run; a redundant install only costs time. So anything this cannot read plainly - a tag, a
   * git url, a range with no single version in it - installs.
   */
  it('installs when the declared version is not plainly the pinned one', () => {
    for (const declared of ['latest', '>=3.0.0 <4', 'github:reticlehq/react', '3.1.9', '^3.1.0']) {
      expect(
        installStatus(plan({ '@reticlehq/react': declared, '@reticlehq/next': declared })),
        `"${declared}" must not be read as satisfying 3.2.0`,
      ).toBe(StepStatus.APPLY);
    }
  });

  /* With no pin there is no version to compare, so presence is the whole question. */
  it('treats presence as enough when nothing is pinned', () => {
    expect(
      installStatus(plan({ '@reticlehq/react': '^3.1.0', '@reticlehq/next': 'latest' }, '')),
    ).toBe(StepStatus.ALREADY);
  });
});
