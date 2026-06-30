import { defineConfig } from 'vite';

// The large-DOM benchmark fixture. Runs on its own port so it never collides with the demo (4310) or the
// benchmark demo (4312). `reticle drive http://localhost:4313` opens it in a real browser. The SDK dials
// the bridge on RETICLE_PORT (default 4455 — the port the benchmark harness spawns the server on).
const RETICLE_PORT = Number(process.env['RETICLE_PORT'] ?? 4455);

export default defineConfig({
  server: { port: 4313, strictPort: true },
  define: { __RETICLE_PORT__: RETICLE_PORT },
});
