import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This plugin has to load in a CommonJS config, and for one blunt reason: without
 * `"type": "module"` in the app's package.json, Vite bundles `vite.config.ts` as CJS and `require`s
 * it. An ESM-only plugin cannot be required, so the import `init` writes could not be loaded and the
 * dev server refused to start at all — the app served nothing until the user deleted our line.
 *
 * Every Vite surface this repo owns sets `"type": "module"`, and the install gate scaffolds with
 * `npm create vite`, which emits it. So the failure needs an app OLDER than the scaffolds we
 * generate, which is a large population — apps predating that default, CRA migrations, and any
 * package.json written by hand — and structurally invisible to every check we had.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The `import.meta` the plugin PRINTS into the connect module, as opposed to any it reads itself. */
const EMITTED_HOT_CONTEXT_READ = 'if (import.meta.hot) reticle.observeHotUpdates(import.meta.hot);';
const PKG_ROOT = join(HERE, '..');

describe('the published package can be loaded by a CommonJS Vite config', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, Record<string, Record<string, string> | string>>;
    files: string[];
    scripts: Record<string, string>;
  };

  it('declares a `require` condition on the main entry', () => {
    const main = pkg.exports['.'];
    expect(main?.['require']).toBeDefined();
    expect(main?.['import']).toBeDefined();
  });

  it('ships types for the require condition, so a CJS config is not untyped', () => {
    // Types are declared PER CONDITION. One flat `types` alongside a `require` entry resolves
    // declarations Node reads as ESM for a package that exports CommonJS, so the types only work
    // under a dynamic import - publint fails the package for it, and a CJS config silently
    // degrades to `any`.
    const req = pkg.exports['.']?.['require'] as Record<string, string> | undefined;
    const imp = pkg.exports['.']?.['import'] as Record<string, string> | undefined;
    expect(req?.['default']).toMatch(/\.cjs$/);
    expect(req?.['types']).toMatch(/\.d\.cts$/);
    expect(imp?.['types']).toMatch(/\.d\.ts$/);
  });

  describe('the built artefact', () => {
    const cjsPath = join(PKG_ROOT, 'dist', 'index.cjs');

    beforeAll(() => {
      rmSync(cjsPath, { force: true });
      // The build script directly, with the node that is already running, rather than through the
      // package manager: on Windows `pnpm` is a `.cmd` shim and `execFileSync` cannot spawn one
      // without a shell, so this suite failed there with ENOENT while passing everywhere else.
      execFileSync(process.execPath, [join(PKG_ROOT, 'scripts', 'build-cjs.mjs')], {
        cwd: PKG_ROOT,
        stdio: 'pipe',
      });
    }, 120_000);

    it('exists after a build', () => {
      expect(existsSync(cjsPath)).toBe(true);
    });

    it('is requirable, and yields a serve-only plugin', () => {
      // `createRequire` from this file, so the plugin's own dependencies resolve as they would for a
      // real consumer. A bare import would load the ESM build and prove nothing about this one.
      const required = createRequire(import.meta.url)(cjsPath) as {
        reticle: (o: { port: number }) => { name: string; apply: string };
      };
      const plugin = required.reticle({ port: 4400 });
      expect(plugin.name).toBe('reticle');
      // The guarantee that keeps instrumentation out of a production bundle has to survive the
      // second build, or the CJS path is a hole in it.
      expect(plugin.apply).toBe('serve');
    });

    it('carries no live `import.meta`, which is empty under CJS', () => {
      // esbuild warns and substitutes an empty object rather than failing, so a build that still
      // reads `import.meta` compiles and then quietly loses whatever it was reading.
      //
      // One occurrence is legitimate and must be excused rather than banned: the connect module this
      // plugin GENERATES reads `import.meta.hot` to hand Vite's hot-update channel to the SDK. That
      // is app source printed as a string, served by Vite and evaluated in the browser — never a
      // value this bundle reads — and it is the only way an app can observe a hot update at all.
      const built = readFileSync(cjsPath, 'utf8').split(EMITTED_HOT_CONTEXT_READ).join('');
      expect(built).not.toMatch(/\bimport\.meta\b/);
    });
  });
});
