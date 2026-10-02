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
import { buildPlan, StepStatus, type PlanInput } from '@/plan/plan.js';
import {
  CONTAINER_MARKERS,
  CONTAINERISED_TITLE,
  containerisedDevServerNote,
  runsDevServer,
} from './containerised-dev-server.js';
import { runInit } from '@/run.js';
import { memoryIo } from '@/memory-io.test-helpers.js';
import { Framework, PackageManager, UiLibrary } from '@/detect/detect.js';

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

/**
 * React Router's template ships a production Dockerfile — a multi-stage build ending in
 * `CMD ["npm", "run", "start"]` — and the notice fired on it, telling a reader whose dev server runs
 * on the host to rebuild an image and mount a token. A container file only means something here when
 * the container runs the dev server.
 */
describe('which container files count', () => {
  const REACT_ROUTER_DOCKERFILE = `FROM node:20-alpine AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN npm ci

FROM node:20-alpine AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build

FROM node:20-alpine
COPY ./package.json package-lock.json /app/
COPY --from=build-env /app/build /app/build
WORKDIR /app
CMD ["npm", "run", "start"]
`;

  it('ignores a production image that builds and starts the app', () => {
    expect(runsDevServer('Dockerfile', REACT_ROUTER_DOCKERFILE, 'react-router dev')).toBe(false);
  });

  it('counts a container that runs the dev script or a dev-server command', () => {
    expect(runsDevServer('Dockerfile', 'CMD ["npm", "run", "dev"]', 'vite')).toBe(true);
    expect(runsDevServer('Dockerfile', 'CMD pnpm dev --host', undefined)).toBe(true);
    expect(runsDevServer('docker-compose.yml', 'command: yarn dev', undefined)).toBe(true);
    expect(runsDevServer('compose.yaml', 'command: npx next dev -H 0.0.0.0', undefined)).toBe(true);
    expect(runsDevServer('Dockerfile', 'CMD ["npx", "vite", "--host"]', undefined)).toBe(true);
    expect(runsDevServer('Dockerfile', 'CMD ng serve --host 0.0.0.0', undefined)).toBe(true);
    // The app's own dev script, whatever it is called on the command line.
    expect(runsDevServer('Dockerfile', 'CMD react-router dev', 'react-router dev')).toBe(true);
  });

  it('does not count vite build or vite preview as a dev server', () => {
    expect(runsDevServer('Dockerfile', 'RUN npx vite build\nCMD npx vite preview', undefined)).toBe(
      false,
    );
  });

  it('always counts a devcontainer — it is the dev environment by definition', () => {
    expect(runsDevServer('.devcontainer/devcontainer.json', '{}', undefined)).toBe(true);
  });

  it('is silent on a React Router app whose only container file is its production Dockerfile', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({
        name: 'rr',
        scripts: {
          dev: 'react-router dev',
          build: 'react-router build',
          start: 'react-router-serve ./build/server/index.js',
        },
        dependencies: {
          react: '^19.0.0',
          'react-router': '^7.0.0',
          '@react-router/node': '^7.0.0',
        },
        devDependencies: { '@react-router/dev': '^7.0.0', vite: '^7.0.0' },
      }),
      'react-router.config.ts': 'export default { ssr: true };\n',
      'vite.config.ts':
        "import { reactRouter } from '@react-router/dev/vite';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [reactRouter()] });\n",
      Dockerfile: REACT_ROUTER_DOCKERFILE,
    });
    runInit({ cwd: '/app', port: undefined, mcp: false, install: false, dryRun: true }, io);
    expect(io.lines.join('\n')).not.toContain(CONTAINERISED_TITLE);
  });
});
