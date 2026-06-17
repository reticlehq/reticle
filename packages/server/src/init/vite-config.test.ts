import { describe, expect, it } from 'vitest';
import { patchViteConfig, VitePatchKind, VITE_IMPORT } from './vite-config.js';

const BASIC = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`;

describe('patchViteConfig', () => {
  it('adds the import and iris() into the plugins array', () => {
    const r = patchViteConfig(BASIC);
    expect(r.kind).toBe(VitePatchKind.APPLY);
    if (r.kind !== VitePatchKind.APPLY) return;
    expect(r.code).toContain(VITE_IMPORT);
    expect(r.code).toMatch(/plugins:\s*\[iris\(\),\s*react\(\)\]/);
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

  it('bails to manual when there is no plugins array', () => {
    const r = patchViteConfig(`import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 3000 } });
`);
    expect(r.kind).toBe(VitePatchKind.MANUAL);
  });

  it('prepends the import when the config has none', () => {
    const r = patchViteConfig('export default { plugins: [] };\n');
    if (r.kind !== VitePatchKind.APPLY) throw new Error('expected apply');
    expect(r.code.startsWith(VITE_IMPORT)).toBe(true);
  });
});
