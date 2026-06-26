import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// `vite.build.target` is bumped to es2022 so Astro doesn't try to down-level the modern @syrin/iris
// bundle to its conservative default browser target (which fails on a destructuring transform).
export default defineConfig({
  integrations: [react()],
  server: { port: 5304 },
  vite: { build: { target: 'es2022' }, optimizeDeps: { esbuildOptions: { target: 'es2022' } } },
});
