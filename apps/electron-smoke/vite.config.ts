import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/vite-plugin';

/**
 * The whole Reticle integration for the renderer, in one line.
 *
 * `desktop: true` does the two things a desktop shell needs and a web app must never get: the plugin
 * also runs for `vite build` (a packaged renderer is a production build with no dev server, so the
 * default serve-only gating would ship an app with no connect() at all), and connect() is called
 * with `allowInProduction` so the SDK's production backstop does not refuse to start.
 *
 * `base: './'` is a plain Electron requirement: index.html is loaded over file://, where an absolute
 * /assets/... path resolves against the filesystem root and every script 404s.
 */
export default defineConfig({
  base: './',
  plugins: [react(), reticle({ desktop: true })],
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist' },
});
