/**
 * The install shape Reticle assumes, and the projects that do not have it.
 *
 * From a field install: a Vite dev server in Docker, the daemon on the host. Two failures, both of
 * which look from the page like "the SDK loaded and no session appeared" —
 *
 *   1. `init` added two dependencies; the container installs its own `node_modules` into an
 *      anonymous volume, so restarting it picked up neither. Found through a failed image build.
 *   2. the build plugin read `$HOME/.reticle/pairing-token` INSIDE the container, did not find one,
 *      minted its own, and the bridge refused every page with `authentication failed`.
 *
 * Together those cost about nine minutes of a seventeen-minute install. The daemon now explains the
 * second when it happens; this exists to say both before either does.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, StepStatus, type PlanInput } from '../plan/plan.js';
import { CONTAINER_MARKERS, containerisedDevServerNote } from './containerised-dev-server.js';
import { Framework, PackageManager, UiLibrary } from '../detect/detect.js';

const INPUT: PlanInput = {
  detection: {
    framework: Framework.VITE,
    uiLibrary: UiLibrary.REACT,
    typescript: true,
    reactMajor: 19,
    needsSourceMapping: true,
    packageManager: PackageManager.PNPM,
  },
  claudeCli: false,
  mcpExists: false,
  viteConfig: null,
  nextConfigFile: null,
  nextReticleDevExists: false,
  options: { port: undefined, mcp: false, install: false },
};

const containerStep = (input: PlanInput): { detail: string } | undefined =>
  buildPlan(input).steps.find(
    (s) => s.status === StepStatus.NOTICE && s.detail.includes('container'),
  );

describe('the containerised dev-server notice', () => {
  it('is absent for an ordinary project, so it does not move the install baseline', () => {
    expect(containerStep(INPUT)).toBeUndefined();
  });

  it('appears when a container marker was found near the app', () => {
    expect(containerStep({ ...INPUT, containerMarker: 'docker-compose.yml' })).toBeDefined();
  });

  it('names the rebuild, because restarting the container installs nothing', () => {
    const detail = containerStep({ ...INPUT, containerMarker: 'Dockerfile' })?.detail ?? '';
    expect(detail).toContain('renew-anon-volumes');
  });

  it('names the token variable — it is the fix, and it appears in no other output', () => {
    const detail = containerStep({ ...INPUT, containerMarker: 'Dockerfile' })?.detail ?? '';
    expect(detail).toContain('RETICLE_PAIRING_TOKEN_DIR');
    expect(detail).toContain('pairing-token:ro');
  });

  it('warns that the host token must exist first, or Docker creates a directory there', () => {
    expect(containerisedDevServerNote('Dockerfile')).toMatch(/DIRECTORY/);
  });

  it('asks for nothing — a notice never counts as an outstanding step', () => {
    const plan = buildPlan({ ...INPUT, containerMarker: 'Dockerfile' });
    const step = plan.steps.find((s) => s.detail.includes('RETICLE_PAIRING_TOKEN_DIR'));
    expect(step?.status).toBe(StepStatus.NOTICE);
    expect(step?.write).toBeUndefined();
    expect(step?.exec).toBeUndefined();
  });

  it('covers compose and devcontainer layouts, not just a bare Dockerfile', () => {
    expect(CONTAINER_MARKERS).toContain('docker-compose.yml');
    expect(CONTAINER_MARKERS).toContain('compose.yaml');
    expect(CONTAINER_MARKERS).toContain('.devcontainer/devcontainer.json');
  });
});
