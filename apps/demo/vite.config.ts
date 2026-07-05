import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/core/vite';

// reticle() is dev-only (dropped from the production build). It stamps data-reticle-source for
// DOM -> file:line mapping and auto-injects reticle.connect() so the app attaches to the bridge.
export default defineConfig({
  // port must match the reticle daemon this repo's MCP drives (RETICLE_PORT in root .mcp.json).
  // The default 4400 is taken by a separate Reticle-protocol daemon (Syrin/iris) on this machine.
  plugins: [react(), reticle({ port: 58432 })],
});
