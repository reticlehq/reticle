import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import reticleSource from '@reticlehq/babel-plugin';

// Benchmark fixture. App serves on 4312; its Reticle SDK dials the daemon on RETICLE_PORT
// (default 4460 — dedicated so it never collides with iris:4400 or the local mcp daemon).
// The benchmark harness sets RETICLE_PORT to match the daemon it spawns.
const RETICLE_PORT = Number(process.env['RETICLE_PORT'] ?? 4460);

export default defineConfig({
  // Stamp data-reticle-source on host elements in dev so reticle_inspect can map DOM -> file:line.
  plugins: [babel({ plugins: [reticleSource] }), react()],
  server: { port: 4312 },
  define: { __RETICLE_PORT__: RETICLE_PORT },
});
