import { describe, expect, it } from 'vitest';
import { patchViteConfig, VitePatchKind, VITE_IMPORT } from './vite-config.js';

const BASIC = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`;

describe('patchViteConfig', () => {
  it('adds the import and reticle() into the plugins array', () => {
    const r = patchViteConfig(BASIC);
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain(VITE_IMPORT);
    expect(r.code).toMatch(/plugins:\s*\[reticle\(\),\s*react\(\)\]/);
  });

  it('places the import after the last existing import', () => {
    const r = patchViteConfig(BASIC);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    const importIdx = r.code.indexOf(VITE_IMPORT);
    const exportIdx = r.code.indexOf('export default');
    expect(importIdx).toBeGreaterThan(0);
    expect(importIdx).toBeLessThan(exportIdx);
  });

  it('is idempotent — already-patched configs are left alone', () => {
    const r = patchViteConfig(BASIC);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    expect(patchViteConfig(r.code).kind).toBe(VitePatchKind.ALREADY);
  });

  it('bakes a non-default port into the reticle() call', () => {
    const r = patchViteConfig(BASIC, 5000);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    expect(r.code).toContain('reticle({ port: 5000 })');
  });

  it('emits bare reticle() when no port is given', () => {
    const r = patchViteConfig(BASIC);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    // Spaced to match the line it lands on: single-line arrays keep the space, multi-line ones
    // would otherwise be left with trailing whitespace for a formatter to rewrite.
    expect(r.code).toContain('reticle(),');
    expect(r.code).not.toContain('port:');
  });

  /**
   * A config with no `plugins` key is a config we can still finish: the object literal is right
   * there and adding the key is the same edit as extending the array. Bailing here sent a user who
   * had only ever set `server.port` to a manual paste for a change we could make correctly.
   */
  it('adds a plugins array when defineConfig has none', () => {
    const r = patchViteConfig(`import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 3000 } });
`);
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain(VITE_IMPORT);
    expect(r.code).toContain('plugins: [reticle()]');
    // The existing config must survive intact.
    expect(r.code).toContain('server: { port: 3000 }');
  });

  it('adds a plugins array to a multi-line defineConfig', () => {
    const r = patchViteConfig(`import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
  },
});
`);
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain('plugins: [reticle()],');
    expect(r.code).toContain('port: 3000');
  });

  it('adds a plugins array to a bare object export', () => {
    const r = patchViteConfig('export default {};\n');
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain('plugins: [reticle()]');
  });

  it('still bails to manual when there is no config object to extend', () => {
    const r = patchViteConfig(`import { defineConfig } from 'vite';
export default defineConfig(buildOptions());
`);
    expect(r.kind).toBe(VitePatchKind.MANUAL);
  });

  it('prepends the import when the config has none', () => {
    const r = patchViteConfig('export default { plugins: [] };\n');
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    expect(r.code.startsWith(VITE_IMPORT)).toBe(true);
  });
});

/**
 * The patch lands in somebody's source file, so it has to look like something a person wrote. A
 * trailing space before a newline is exactly what a formatter rewrites, turning a one-line install
 * into a diff against the user's own style.
 */
describe('patchViteConfig — the edit reads like the file it lands in', () => {
  it('leaves no trailing whitespace on the plugins line', () => {
    const src = `import { defineConfig } from 'vite';\nexport default defineConfig({\n  plugins: [\n    react(),\n  ],\n});\n`;
    const r = patchViteConfig(src);
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    for (const line of r.code.split('\n')) {
      expect(line, JSON.stringify(line)).toBe(line.replace(/\s+$/, ''));
    }
  });
});
