import { describe, expect, it } from 'vitest';
import { PatchKind } from './patch-kind.js';
import { ELECTRON_VITE_IMPORT, patchElectronViteConfig } from './electron-vite-patch.js';

const MAIN_FIRST = `import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [vue()] },
});
`;

const NO_RENDERER_PLUGINS = `import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { '@renderer': './src' } },
  },
});
`;

const FIXTURE_UNPATCHED = `import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue()
    ]
  }
})
`;

describe('patchElectronViteConfig', () => {
  it('patches the renderer block even when main comes first and has its own plugins', () => {
    const r = patchElectronViteConfig(MAIN_FIRST);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain(ELECTRON_VITE_IMPORT);
    expect(r.code).toContain('desktop: true');
    const renderer = r.code.slice(r.code.indexOf('renderer:'));
    expect(renderer).toMatch(/plugins:\s*\[reticle\([^)]*desktop:\s*true[^)]*\),\s*vue\(\)\]/);
    const main = r.code.slice(r.code.indexOf('main:'), r.code.indexOf('preload:'));
    expect(main).not.toContain('reticle(');
  });

  it('adds a plugins key when renderer has none', () => {
    const r = patchElectronViteConfig(NO_RENDERER_PLUGINS);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    const renderer = r.code.slice(r.code.indexOf('renderer:'));
    expect(renderer).toContain('plugins: [reticle({ desktop: true, captureNetworkBodies: true })]');
    const main = r.code.slice(r.code.indexOf('main:'), r.code.indexOf('renderer:'));
    expect(main).not.toContain('reticle(');
  });

  it('bails when renderer is not an object literal', () => {
    const src = `export default defineConfig({
  main: {},
  renderer: sharedRenderer,
});`;
    const r = patchElectronViteConfig(src);
    expect(r.kind).toBe(PatchKind.MANUAL);
    if (r.kind !== PatchKind.MANUAL) return;
    expect(r.reason).toMatch(/object literal/);
  });

  it('bails when there is no renderer key', () => {
    const r = patchElectronViteConfig(`export default defineConfig({ main: {} });`);
    expect(r.kind).toBe(PatchKind.MANUAL);
    if (r.kind !== PatchKind.MANUAL) return;
    expect(r.reason).toMatch(/renderer/);
  });

  it('bakes a non-default port into the renderer call', () => {
    const r = patchElectronViteConfig(MAIN_FIRST, 5000);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain('port: 5000');
    expect(r.code).toContain('desktop: true');
  });

  it('is idempotent when the renderer already has desktop: true', () => {
    const first = patchElectronViteConfig(MAIN_FIRST);
    expect(first.kind).toBe(PatchKind.APPLY);
    if (first.kind !== PatchKind.APPLY) return;
    expect(patchElectronViteConfig(first.code).kind).toBe(PatchKind.ALREADY);
  });

  it('reports MANUAL, not ALREADY, when the plugin is only in main', () => {
    const src = `import { reticle } from '@reticlehq/vite-plugin';
export default defineConfig({
  main: { plugins: [reticle({ desktop: true })] },
  renderer: { plugins: [vue()] },
});`;
    const r = patchElectronViteConfig(src);
    expect(r.kind).toBe(PatchKind.MANUAL);
    if (r.kind !== PatchKind.MANUAL) return;
    expect(r.reason).toMatch(/not in the `renderer` block/);
  });

  it('reports MANUAL when renderer has reticle() without desktop: true', () => {
    const src = `import { reticle } from '@reticlehq/vite-plugin';
export default defineConfig({
  main: {},
  renderer: { plugins: [reticle(), vue()] },
});`;
    const r = patchElectronViteConfig(src);
    expect(r.kind).toBe(PatchKind.MANUAL);
    if (r.kind !== PatchKind.MANUAL) return;
    expect(r.reason).toMatch(/desktop: true/);
  });

  it('patches the fixture template into the corrected fixture shape', () => {
    const r = patchElectronViteConfig(FIXTURE_UNPATCHED);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain(ELECTRON_VITE_IMPORT);
    expect(r.code).toMatch(
      /plugins:\s*\[\s*reticle\(\{\s*desktop:\s*true,\s*captureNetworkBodies:\s*true\s*\}\),/,
    );
    expect(r.code).toContain('vue()');
    const main = r.code.slice(r.code.indexOf('main:'), r.code.indexOf('preload:'));
    expect(main).not.toContain('reticle(');
  });
});
