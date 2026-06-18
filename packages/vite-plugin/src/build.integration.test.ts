import { describe, expect, it, beforeAll } from 'vitest';
import { iris, IRIS_VITE_PLUGIN_NAME } from './index.js';

/**
 * Proves the prod-safety claim against Vite's *actual* config resolution rather than a unit
 * assertion on the `apply` field: `resolveConfig(..., 'build')` runs Vite's own apply-filter, so a
 * plugin missing from the resolved build pipeline can never touch a production bundle. Skipped when
 * `vite` is not installed (e.g. offline local runs); CI installs it as a devDependency.
 */

type ResolveConfig = (
  inline: { plugins: unknown[]; configFile: false; logLevel: 'silent' },
  command: 'build' | 'serve',
) => Promise<{ plugins: readonly { name: string }[] }>;

let resolveConfig: ResolveConfig | undefined;

beforeAll(async () => {
  try {
    const vite = (await import('vite')) as { resolveConfig: ResolveConfig };
    resolveConfig = vite.resolveConfig;
  } catch {
    resolveConfig = undefined;
  }
});

function names(plugins: readonly { name: string }[]): string[] {
  return plugins.map((p) => p.name);
}

describe('iris() in the real Vite config resolution', () => {
  it('is included in the serve pipeline', async () => {
    if (resolveConfig === undefined) return;
    const resolved = await resolveConfig(
      { plugins: [iris()], configFile: false, logLevel: 'silent' },
      'serve',
    );
    expect(names(resolved.plugins)).toContain(IRIS_VITE_PLUGIN_NAME);
  });

  it('is filtered out of the build pipeline (never ships to production)', async () => {
    if (resolveConfig === undefined) return;
    const resolved = await resolveConfig(
      { plugins: [iris()], configFile: false, logLevel: 'silent' },
      'build',
    );
    expect(names(resolved.plugins)).not.toContain(IRIS_VITE_PLUGIN_NAME);
  });
});
