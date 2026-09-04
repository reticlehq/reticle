/**
 * #683: a correct install read as a broken one.
 *
 * The install step's idempotent re-check WAS the install command. So a project whose packages were
 * already there — installed by hand after a first run failed, or by a teammate — had `init` execute
 * the same failing command again and report `⚠ Install dependencies — step failed` over an install
 * that was fine. Two full init runs where one should do.
 */
import { describe, expect, it } from 'vitest';
import { detect, Framework, PackageManager, UiLibrary, type Detection } from './detect.js';
import { buildPlan, StepStatus, type PlanInput } from './plan.js';
import { installFailureHint } from './install-hint.js';

const VITE_REACT: Detection = {
  framework: Framework.VITE,
  uiLibrary: UiLibrary.REACT,
  typescript: true,
  reactMajor: 19,
  needsSourceMapping: true,
  packageManager: PackageManager.PNPM,
};

const planInput = (
  installedPackages: Record<string, string | undefined> | undefined,
  sdkVersion?: string,
  install = true,
): PlanInput => ({
  detection: VITE_REACT,
  claudeCli: false,
  mcpExists: false,
  viteConfig: null,
  nextConfigFile: null,
  nextReticleDevExists: false,
  options: {
    port: 4400,
    mcp: true,
    projectId: 'demo',
    install,
    ...(sdkVersion === undefined ? {} : { sdkVersion }),
  },
  ...(installedPackages === undefined ? {} : { installedPackages }),
});

const installStepOf = (input: PlanInput) =>
  buildPlan(input).steps.find((step) => 'Install dependencies' === step.title);

describe('the install step verifies rather than re-running', () => {
  it('reports ALREADY when every package resolves', () => {
    const step = installStepOf(
      planInput({ '@reticlehq/react': '2.13.1', '@reticlehq/vite-plugin': '2.13.1' }),
    );

    expect(step?.status).toBe(StepStatus.ALREADY);
    expect(step?.detail).toContain('@reticlehq/react@2.13.1');
    // And nothing is executed: re-running the package manager is the bug.
    expect(step?.exec).toBeUndefined();
  });

  it('installs when one package is missing', () => {
    const step = installStepOf(planInput({ '@reticlehq/react': '2.13.1' }));
    expect(step?.status).toBe(StepStatus.APPLY);
    expect(step?.exec).toBeDefined();
  });

  it('installs when a package resolves to nothing', () => {
    const step = installStepOf(
      planInput({ '@reticlehq/react': '2.13.1', '@reticlehq/vite-plugin': '' }),
    );
    expect(step?.status).toBe(StepStatus.APPLY);
  });

  it('installs when the facts were not read at all', () => {
    // A missing reading must never be able to SKIP an install — the direction an absent fact
    // should be wrong in.
    expect(installStepOf(planInput(undefined))?.status).toBe(StepStatus.APPLY);
  });

  it('does NOT report already when a pinned version is not the one installed', () => {
    // The version-skew case pinning exists for: an older SDK against a newer daemon surfaces as a
    // -32000 with nothing naming a version, and calling that "already installed" would be the
    // report agreeing with the broken state.
    const step = installStepOf(
      planInput({ '@reticlehq/react': '2.12.0', '@reticlehq/vite-plugin': '2.12.0' }, '2.13.1'),
    );
    expect(step?.status).toBe(StepStatus.APPLY);
  });

  it('reports already when the pinned version IS the one installed', () => {
    const step = installStepOf(
      planInput({ '@reticlehq/react': '2.13.1', '@reticlehq/vite-plugin': '2.13.1' }, '2.13.1'),
    );
    expect(step?.status).toBe(StepStatus.ALREADY);
  });

  it('splits a scoped name from its version at the LAST @', () => {
    // `@reticlehq/react@2.13.1` — a scoped package starts with an @, so the first one is not the
    // separator. Getting this wrong reads the name as `` and never matches.
    const step = installStepOf(
      planInput({ '@reticlehq/react': '2.13.1', '@reticlehq/vite-plugin': '2.13.1' }, '2.13.1'),
    );
    expect(step?.detail).toContain('@reticlehq/react@2.13.1');
    expect(step?.detail).not.toContain('@@');
  });

  it('leaves the manual (no --install) path alone', () => {
    const input = planInput(
      { '@reticlehq/react': '2.13.1', '@reticlehq/vite-plugin': '2.13.1' },
      undefined,
      false,
    );
    expect(installStepOf(input)?.status).toBe(StepStatus.MANUAL);
  });
});

describe('the failure hint', () => {
  it('names the symlinked virtual store, which is what pnpm actually reported', () => {
    const hint = installFailureHint(PackageManager.PNPM);
    expect(hint).toContain('ERR_PNPM_UNEXPECTED_VIRTUAL_STORE');
    expect(hint).toContain('symlinked');
    expect(hint).toContain('pnpm install');
  });

  it('still names the maturity window and the registry', () => {
    const hint = installFailureHint(PackageManager.PNPM);
    expect(hint).toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION');
    expect(hint).toContain('registry');
  });

  it('says nothing about pnpm on another package manager', () => {
    expect(installFailureHint(PackageManager.NPM)).not.toContain('ERR_PNPM');
  });
});

describe('detect still works unchanged', () => {
  it('reads a pnpm vite react app', () => {
    const detection = detect({
      pkg: { dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^6.0.0' } },
      configFiles: new Set(['vite.config.ts']),
      lockfiles: new Set(['pnpm-lock.yaml']),
    });
    expect(detection.framework).toBe(Framework.VITE);
    expect(detection.packageManager).toBe(PackageManager.PNPM);
  });
});
