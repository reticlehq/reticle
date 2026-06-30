import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import reticleSource from '@reticle/babel-plugin';

// The Reticle showcase dashboard runs on a dedicated port (4310) so it never collides with other
// local apps (e.g. AlianPost on :3000). `reticle drive http://localhost:4310` opens it in a real
// browser. Change the port here only — e2e specs + docs read this value.
const RETICLE_PORT = Number(process.env['RETICLE_PORT'] ?? 4400);

export default defineConfig({
  // Stamp data-reticle-source on host elements in dev so reticle_inspect can map DOM -> file:line
  // (React 19 removed _debugSource). Dev-only; harmless in prod builds.
  plugins: [babel({ plugins: [reticleSource] }), react()],
  server: { port: 4310 },
  define: { __RETICLE_PORT__: RETICLE_PORT },
});
