/**
 * Smoke test for the umbrella's `@reticlehq/core/next` export — the regression guard for the v1.0/1.1 bug
 * where `withReticle` crashed a Next host with `__require.resolve is not a function`.
 *
 * It exercises the PUBLISHED shape (imported via the package's ./next export, ESM): the module loads
 * without a require.resolve crash, the webpack hook points at a loader that is ACTUALLY SHIPPED on
 * disk, and that loader transforms JSX (stamping data-reticle-source) using the bundled babel plugin —
 * NOT the private @reticlehq/babel-plugin. The old smoke used the private @reticlehq/next package,
 * which is exactly why this slipped through; this imports the umbrella like a real consumer does.
 *
 * Requires the workspace to be built (it imports the built dist). Run via `pnpm test:integration`.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
// Imported through the package's ./next export — ESM, exactly as a Next host does.
import { withReticle } from '@reticlehq/core/next';

interface LoaderRule {
  use?: { loader?: string }[];
}
interface MutableConfig {
  module: { rules: LoaderRule[] };
}

function applyWebpack(): MutableConfig {
  const cfg = withReticle({}) as { webpack?: (c: MutableConfig, ctx: unknown) => MutableConfig };
  expect(typeof cfg.webpack).toBe('function');
  const config: MutableConfig = { module: { rules: [] } };
  cfg.webpack?.(config, {});
  return config;
}

function reticleLoaderPath(config: MutableConfig): string {
  const rule = config.module.rules.find((r) => r.use?.[0]?.loader?.includes('loader.cjs'));
  const loader = rule?.use?.[0]?.loader;
  if (loader === undefined) throw new Error('reticle loader rule not found');
  return loader;
}

describe('@reticlehq/core/next — withReticle (ESM smoke)', () => {
  it('loads under ESM and returns a config with a webpack hook (no require.resolve crash)', () => {
    expect(typeof withReticle).toBe('function');
  });

  it('the webpack hook points at a loader that is actually SHIPPED on disk', () => {
    const loaderPath = reticleLoaderPath(applyWebpack());
    expect(existsSync(loaderPath)).toBe(true);
  });

  it('the shipped loader stamps data-reticle-source on JSX via the bundled babel plugin', async () => {
    const loaderPath = reticleLoaderPath(applyWebpack());
    const require_ = createRequire(import.meta.url);
    // The loader is plain CJS (module.exports = function), as webpack requires it.
    const loader = require_(loaderPath) as (
      this: { resourcePath: string; async: () => (err: unknown, code?: string) => void },
      source: string,
      map: unknown,
    ) => void;

    const transformed = await new Promise<string>((resolve, reject) => {
      const ctx = {
        resourcePath: '/proj/app/page.tsx',
        async: () => (err: unknown, code?: string) =>
          err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(code ?? ''),
      };
      loader.call(ctx, 'export const A = () => <div>hi</div>;\n', null);
    });

    expect(transformed).toContain('data-reticle-source');
  });
});
