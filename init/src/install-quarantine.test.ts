/**
 * Yarn Berry quarantining a release younger than its minimal age gate.
 *
 * Reproduced on a fresh Yarn 4 scaffold: `yarn add -D @reticlehq/react@3.3.0` failed with
 * `All versions satisfying "3.3.0" are quarantined`, init printed "run manually: yarn add -D …"
 * (which fails the same way), and then booted the app anyway and reported "the SDK is NOT in the
 * page … restart the dev server" — sending the reader after a dev server that was never the problem.
 */
import { describe, expect, it } from 'vitest';
import { runInit, type InitOptions } from './run.js';
import { memoryIo } from './memory-io.test-helpers.js';

const QUARANTINED =
  '➤ YN0000: ┌ Resolution step\n' +
  '➤ YN0082: │ @reticlehq/react@npm:3.3.0: All versions satisfying "3.3.0" are quarantined\n' +
  '➤ YN0000: └ Completed in 0s 412ms\n';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'yarn-app',
    packageManager: 'yarn@4.10.3',
    scripts: { dev: 'vite' },
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^5.0.0' },
  }),
  'yarn.lock': '',
  '.yarnrc.yml': 'nodeLinker: node-modules\n',
  'vite.config.ts':
    "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
  'index.html': '<!doctype html><html><body><div id="root"></div></body></html>\n',
};

const OPTS: InitOptions = {
  cwd: '/app',
  port: undefined,
  mcp: false,
  install: true,
  dryRun: false,
  continuesToRuntime: true,
};

const failingInstall = (output: string) => {
  const io = memoryIo(FILES);
  return { ...io, exec: () => false, capture: () => ({ ok: false, output }) };
};

describe('a quarantined release', () => {
  it('names the age gate and the command that works, instead of the one that fails again', () => {
    const io = failingInstall(QUARANTINED);
    const result = runInit(OPTS, io);
    const printed = io.lines.join('\n');
    expect(printed).toContain('quarantined');
    expect(printed).toContain('npmMinimalAgeGate');
    expect(printed).toMatch(/YARN_NPM_MINIMAL_AGE_GATE=0 yarn add -D .*@reticlehq\/react@/);
    expect(result.ok).toBe(false);
  });

  it('does not hand the runtime a project to boot: nothing was wired', () => {
    // `context` is what the runtime phase boots the app from. Without it, setup stops at init's own
    // report instead of starting a dev server and diagnosing an SDK that was never installed.
    expect(runInit(OPTS, failingInstall(QUARANTINED)).context).toBeUndefined();
  });

  it('says nothing about quarantine when the install failed for another reason', () => {
    const io = failingInstall(
      '➤ YN0001: │ RequestError: getaddrinfo ENOTFOUND registry.yarnpkg.com\n',
    );
    const result = runInit(OPTS, io);
    expect(io.lines.join('\n')).not.toContain('npmMinimalAgeGate');
    expect(result.context).toBeUndefined();
  });

  it('still hands over a project whose install succeeded', () => {
    expect(runInit(OPTS, memoryIo(FILES)).context).toBeDefined();
  });
});
