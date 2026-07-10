import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/vite-plugin';

// reticle() is dev-only (dropped from the production build). It stamps data-reticle-source for
// DOM -> file:line mapping and auto-injects reticle.connect() so the app attaches to the bridge.
export default defineConfig({
  // Serve on a fixed port so the e2e battery (apps/e2e/run-ci.sh) and local dogfooding can find the app;
  // strictPort fails loudly instead of silently drifting to vite's default when the port is taken.
  server: { port: 4310, strictPort: true },
  // port must match the reticle daemon this repo's MCP drives (RETICLE_PORT in root .mcp.json).
  // The default 4400 is taken by a separate Reticle-protocol daemon on this machine.
  plugins: [react(), reticle({ port: 58432 })],
});
