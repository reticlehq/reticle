/**
 * Angular had no path at all, and every one `init` offered failed.
 *
 * `@angular/core` matched no framework, so the app fell through to plain HTML: it installed
 * `@reticlehq/react` and `react` into an Angular codebase, pointed the ⚠ at `index.html` (Angular's
 * is `src/index.html`), and offered two snippets — a bundled one that does not compile under
 * Angular's strict TypeScript (`process` is not declared), and a CDN one that `ng build` copies,
 * pairing token and all, into the production `index.html`.
 *
 * The path below is the one proven by hand on Angular 22 with and without SSR: a dynamic import of
 * the sensor guarded on `ngDevMode`, which kept `ng build` green and Reticle out of the
 * bundle. The pairing token reaches the page through `ng serve` alone — see `patch/angular.ts`.
 */
import { describe, expect, it } from 'vitest';
import { detect, Framework, UiLibrary, type DetectInput } from './detect/detect.js';
import { frameworkPackages } from './plan/plan.js';
import { runInit, type InitOptions } from './run.js';
import { memoryIo, TEST_PAIRING_TOKEN } from './memory-io.test-helpers.js';
import {
  ANGULAR_PROXY_PATH,
  ANGULAR_TOKEN_PATH,
  angularEntry,
  patchAngularJson,
  patchAngularMain,
} from './patch/angular.js';
import { PatchKind } from './patch/patch-kind.js';

const ANGULAR_PKG = {
  name: 'ngapp',
  scripts: { ng: 'ng', start: 'ng serve', build: 'ng build' },
  dependencies: { '@angular/core': '^22.2.0', '@angular/platform-browser': '^22.2.0' },
  devDependencies: { '@angular/build': '^22.2.0', '@angular/cli': '^22.2.0', typescript: '~5.9' },
};

const ANGULAR_JSON = JSON.stringify(
  {
    $schema: './node_modules/@angular/cli/lib/config/schema.json',
    version: 1,
    projects: {
      ngapp: {
        projectType: 'application',
        root: '',
        sourceRoot: 'src',
        architect: {
          build: {
            builder: '@angular/build:application',
            options: { browser: 'src/main.ts', tsConfig: 'tsconfig.app.json' },
          },
          serve: {
            builder: '@angular/build:dev-server',
            configurations: {
              production: { buildTarget: 'ngapp:build:production' },
              development: { buildTarget: 'ngapp:build:development' },
            },
            defaultConfiguration: 'development',
          },
        },
      },
    },
  },
  null,
  2,
);

const MAIN_TS = `import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
`;

const ANGULAR_FILES: Record<string, string> = {
  'package.json': JSON.stringify(ANGULAR_PKG),
  'angular.json': ANGULAR_JSON,
  'tsconfig.json': '{}\n',
  'src/index.html': '<!doctype html><html><body><app-root></app-root></body></html>\n',
  'src/main.ts': MAIN_TS,
};

const OPTS: InitOptions = {
  cwd: '/app',
  port: undefined,
  mcp: false,
  install: false,
  dryRun: false,
};

const detectInput = (over: Partial<DetectInput>): DetectInput => ({
  pkg: {},
  configFiles: new Set<string>(),
  lockfiles: new Set<string>(),
  ...over,
});

describe('detecting Angular', () => {
  it('is Angular, not the plain-HTML fallback', () => {
    expect(detect(detectInput({ pkg: ANGULAR_PKG })).framework).toBe(Framework.ANGULAR);
    expect(detect(detectInput({ configFiles: new Set(['angular.json']) })).framework).toBe(
      Framework.ANGULAR,
    );
  });

  it('installs the framework-neutral sensor and nothing that drags React in', () => {
    expect(frameworkPackages(Framework.ANGULAR, UiLibrary.UNKNOWN)).toEqual(['@reticlehq/browser']);
  });
});

describe('the entry patch', () => {
  it('reads the entry from angular.json, not a guess', () => {
    expect(angularEntry(ANGULAR_JSON)).toBe('src/main.ts');
    const legacy = ANGULAR_JSON.replace('"browser": "src/main.ts"', '"main": "src/app-main.ts"');
    expect(angularEntry(legacy)).toBe('src/app-main.ts');
  });

  it('connects only under ngDevMode, through a dynamic import', () => {
    const patch = patchAngularMain(MAIN_TS, 4400, 'ngapp-1234');
    if (patch.kind !== PatchKind.APPLY) throw new Error(`expected APPLY, got ${patch.kind}`);
    const code = patch.code;
    // `isDevMode()` is a runtime call the production build cannot fold, so the whole connect and
    // ~300KB of lazy Reticle chunks shipped in `ng build` output. `ngDevMode` is the global the
    // Angular CLI defines to `false` there, which lets esbuild drop the branch and the import.
    expect(code).toContain("if (typeof ngDevMode === 'undefined' || ngDevMode)");
    expect(code).toContain('declare const ngDevMode: unknown;');
    expect(code).not.toContain('isDevMode');
    expect(code).toContain("import('@reticlehq/browser')");
    expect(code).toContain(ANGULAR_TOKEN_PATH);
    expect(code).toContain("projectId: 'ngapp-1234'");
    // The two ways the old snippets failed on Angular: a Node global strict TS rejects, and a token.
    expect(code).not.toContain('process.env');
    expect(code).not.toContain(TEST_PAIRING_TOKEN);
    // A static import would put the sensor in the initial bundle of a production build.
    expect(code).not.toMatch(/^import .*@reticlehq\/browser/m);
    // The app's own code is untouched.
    for (const line of MAIN_TS.trim().split('\n')) expect(code).toContain(line);
  });

  it('leaves an isDevMode import the app already has alone', () => {
    const source = `import { isDevMode } from '@angular/core';\n${MAIN_TS}`;
    const patch = patchAngularMain(source, 4400, 'p');
    if (patch.kind !== PatchKind.APPLY) throw new Error('expected APPLY');
    expect(patch.code.match(/import \{ isDevMode \}/g)).toHaveLength(1);
  });

  it('rewrites an entry the previous version wired under isDevMode(), in place', () => {
    const LEGACY = `${MAIN_TS}
// Reticle, dev only — written by \`reticle init\`. \`isDevMode()\` is false in a production build,
// so this never runs there. The pairing token comes from \`ng serve\` (reticle.proxy.mjs), so it
// is never in a source file or a bundle.
if (isDevMode()) {
  void Promise.all([
    import('@reticlehq/browser'),
    fetch('${ANGULAR_TOKEN_PATH}')
      .then((res) => (res.ok ? res.text() : ''))
      .catch(() => ''),
  ]).then(([{ reticle }, token]) => {
    reticle.connect({ url: 'ws://localhost:4411/reticle', projectId: 'p', ...(token ? { token } : {}) });
  });
}
`.replace(
      'import { appConfig }',
      "import { isDevMode } from '@angular/core';\nimport { appConfig }",
    );
    const patch = patchAngularMain(LEGACY, 4411, 'p');
    if (patch.kind !== PatchKind.APPLY) throw new Error(`expected APPLY, got ${patch.kind}`);
    expect(patch.code).toContain("if (typeof ngDevMode === 'undefined' || ngDevMode) {");
    expect(patch.code).not.toContain('if (isDevMode())');
    expect(patch.code.match(/declare const ngDevMode/g)).toHaveLength(1);
    // Rewritten in place, not appended beside: one connect, the app's own lines untouched.
    expect(patch.code.match(/reticle\.connect/g)).toHaveLength(1);
    expect(patch.code).toContain("url: 'ws://localhost:4411/reticle'");
    for (const line of MAIN_TS.trim().split('\n')) expect(patch.code).toContain(line);
    expect(patchAngularMain(patch.code, 4411, 'p').kind).toBe(PatchKind.ALREADY);
  });

  it('names a non-default daemon port', () => {
    const patch = patchAngularMain(MAIN_TS, 4411, 'p');
    if (patch.kind !== PatchKind.APPLY) throw new Error('expected APPLY');
    expect(patch.code).toContain(':4411');
  });

  it('is idempotent', () => {
    const once = patchAngularMain(MAIN_TS, 4400, 'p');
    if (once.kind !== PatchKind.APPLY) throw new Error('expected APPLY');
    expect(patchAngularMain(once.code, 4400, 'p').kind).toBe(PatchKind.ALREADY);
  });
});

describe('the dev-server token channel', () => {
  it('adds the proxy config to the serve target, which `ng build` never reads', () => {
    const patch = patchAngularJson(ANGULAR_JSON);
    if (patch.kind !== PatchKind.APPLY) throw new Error(`expected APPLY, got ${patch.kind}`);
    const json = JSON.parse(patch.code) as {
      projects: Record<
        string,
        { architect: Record<string, { options?: Record<string, unknown> }> }
      >;
    };
    expect(json.projects['ngapp']?.architect['serve']?.options?.['proxyConfig']).toBe(
      ANGULAR_PROXY_PATH,
    );
    // The build target is where a production bundle comes from; the token must have no route there.
    expect(json.projects['ngapp']?.architect['build']?.options?.['proxyConfig']).toBeUndefined();
    expect(patchAngularJson(patch.code).kind).toBe(PatchKind.ALREADY);
  });

  it('leaves a proxy config the app already has alone, and says what to add to it', () => {
    const own = ANGULAR_JSON.replace(
      '"builder": "@angular/build:dev-server",',
      '"builder": "@angular/build:dev-server",\n          "options": { "proxyConfig": "proxy.conf.json" },',
    );
    const patch = patchAngularJson(own);
    expect(patch.kind).toBe(PatchKind.MANUAL);
    if (patch.kind === PatchKind.MANUAL) expect(patch.reason).toContain('proxy.conf.json');
  });

  it('refuses to guess between several applications', () => {
    const parsed = JSON.parse(ANGULAR_JSON) as { projects: Record<string, unknown> };
    parsed.projects['admin'] = parsed.projects['ngapp'];
    expect(patchAngularJson(JSON.stringify(parsed)).kind).toBe(PatchKind.MANUAL);
  });
});

describe('init on a fresh Angular app', () => {
  it('wires the entry, the proxy and angular.json, and exits green', () => {
    const io = memoryIo(ANGULAR_FILES);
    const result = runInit(OPTS, io);
    expect(io.written['src/main.ts']).toContain("import('@reticlehq/browser')");
    expect(io.written[ANGULAR_PROXY_PATH]).toContain(ANGULAR_TOKEN_PATH);
    expect(io.written['angular.json']).toContain(ANGULAR_PROXY_PATH);
    // Never the React plain-HTML path it used to take.
    expect(io.written['index.html']).toBeUndefined();
    expect(result.ok).toBe(true);
    // No file this run wrote carries the machine's pairing token.
    for (const [path, content] of Object.entries(io.written)) {
      expect(content.includes(TEST_PAIRING_TOKEN), path).toBe(false);
    }
  });

  it('is idempotent', () => {
    const io = memoryIo(ANGULAR_FILES);
    runInit(OPTS, io);
    const again = memoryIo({ ...ANGULAR_FILES, ...io.written });
    expect(runInit(OPTS, again).ok).toBe(true);
    for (const path of ['src/main.ts', 'angular.json', ANGULAR_PROXY_PATH]) {
      expect(again.written[path], path).toBeUndefined();
    }
  });
});

describe('init over an entry the previous version wired', () => {
  it('rewrites the guard in place, and moves the port in the same run', () => {
    const io = memoryIo(ANGULAR_FILES);
    runInit({ ...OPTS, port: 4411 }, io);
    const legacy = (io.written['src/main.ts'] ?? '')
      .replace('declare const ngDevMode: unknown;\n', '')
      .replace("if (typeof ngDevMode === 'undefined' || ngDevMode) {", 'if (isDevMode()) {');
    const again = memoryIo({ ...ANGULAR_FILES, ...io.written, 'src/main.ts': legacy });
    runInit({ ...OPTS, port: 4412 }, again);
    const main = again.written['src/main.ts'] ?? '';
    expect(main).toContain("if (typeof ngDevMode === 'undefined' || ngDevMode) {");
    expect(main).toContain('ws://localhost:4412/reticle');
    expect(main).not.toContain(':4411/');
    expect(main.match(/reticle\.connect/g)).toHaveLength(1);
  });
});
