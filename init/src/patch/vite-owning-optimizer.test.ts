/**
 * `optimizeDeps.esbuildOptions` on a Vite that has moved its dep optimizer to rolldown.
 *
 * Seen on Nuxt 4.5 / Vite 8: the key `init` wrote into `nuxt.config.ts` printed a deprecation WARN
 * on every dev start and every build. The Vite plugin already picks the key per Vite major; the
 * configs `init` patches for Nuxt and Astro never load that plugin, so they need the same answer.
 */
import { describe, expect, it } from 'vitest';
import { patchNuxtConfig } from './nuxt-patch.js';
import { patchAstroConfig } from './astro-patch.js';
import { PatchKind } from './patch-kind.js';
import { installedViteMajor } from './vite-owning-config.js';
import { memoryIo } from '@/memory-io.test-helpers.js';

const NUXT = `export default defineNuxtConfig({\n  devtools: { enabled: true },\n})\n`;
const NUXT_WITH_VITE = `export default defineNuxtConfig({\n  vite: {\n    optimizeDeps: { include: ['x'] },\n  },\n})\n`;
const ASTRO = `import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n`;

const code = (patch: ReturnType<typeof patchNuxtConfig>): string =>
  PatchKind.APPLY === patch.kind ? patch.code : '';

describe('the optimizer options key follows the installed Vite', () => {
  it('writes no esbuildOptions on Vite 7 and later', () => {
    for (const source of [NUXT, NUXT_WITH_VITE]) {
      const out = code(patchNuxtConfig(source, 8));
      expect(out).toContain('@reticlehq/browser');
      expect(out).not.toContain('esbuildOptions');
    }
    expect(code(patchAstroConfig(ASTRO, 7))).not.toContain('esbuildOptions');
  });

  it('keeps the esbuild target on older or unknown Vite', () => {
    expect(code(patchNuxtConfig(NUXT, 6))).toContain("esbuildOptions: { target: 'es2022' }");
    expect(code(patchNuxtConfig(NUXT, null))).toContain("esbuildOptions: { target: 'es2022' }");
    expect(code(patchAstroConfig(ASTRO, 5))).toContain("esbuildOptions: { target: 'es2022' }");
  });

  it('takes the key back out of a config an older init wrote, on a re-run', () => {
    for (const source of [NUXT, NUXT_WITH_VITE]) {
      const old = code(patchNuxtConfig(source, 6));
      const again = patchNuxtConfig(old, 8);
      expect(again.kind).toBe(PatchKind.APPLY);
      expect(code(again)).not.toContain('esbuildOptions');
      expect(code(again)).toContain('__RETICLE_TOKEN__');
      expect(patchNuxtConfig(code(again), 8).kind).toBe(PatchKind.ALREADY);
    }
    expect(patchNuxtConfig(code(patchNuxtConfig(NUXT, 6)), 6).kind).toBe(PatchKind.ALREADY);
  });
});

describe('reading the installed Vite major', () => {
  it("reads the hoisted package, then pnpm's store, then the declared range", () => {
    expect(
      installedViteMajor(
        memoryIo({ 'node_modules/vite/package.json': '{"version":"8.0.16"}' }),
        {},
      ),
    ).toBe(8);
    expect(
      installedViteMajor(
        memoryIo({
          'node_modules/.pnpm/vite@7.1.2_@types+node@24/node_modules/vite/package.json': '{}',
        }),
        {},
      ),
    ).toBe(7);
    expect(installedViteMajor(memoryIo({}), { devDependencies: { vite: '^6.3.0' } })).toBe(6);
    expect(installedViteMajor(memoryIo({}), {})).toBeNull();
  });
});
