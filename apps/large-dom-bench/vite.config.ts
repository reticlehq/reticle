import { defineConfig } from 'vite';

// The large-DOM benchmark fixture. Runs on its own port so it never collides with the demo (4310) or the
// benchmark demo (4312). `iris drive http://localhost:4313` opens it in a real browser. The SDK dials
// the bridge on IRIS_PORT (default 4455 — the port the benchmark harness spawns the server on).
const IRIS_PORT = Number(process.env['IRIS_PORT'] ?? 4455);

export default defineConfig({
  server: { port: 4313, strictPort: true },
  define: { __IRIS_PORT__: IRIS_PORT },
});
