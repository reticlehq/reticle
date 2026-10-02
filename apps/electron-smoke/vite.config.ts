import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/vite-plugin';

/**
 * The whole Reticle integration for the renderer, in one line.
 *
 * `desktop: true` does the two things a desktop shell needs and a web app must never get: connect()
 * is injected into the entry module, so a packaged renderer with no dev server still has it when
 * built with `--mode development` (`dev:packaged`; a production-mode build ships no Reticle code),
 * and connect() is called with `allowInProduction` so the SDK's production backstop does not
 * refuse to start.
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
