import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import irisSource from '@syrin/iris-babel-plugin';

// The Iris showcase dashboard runs on a dedicated port (4310) so it never collides with other
// local apps (e.g. AlianPost on :3000). `iris drive http://localhost:4310` opens it in a real
// browser. Change the port here only — e2e specs + docs read this value.
export default defineConfig({
  // Stamp data-iris-source on host elements in dev so iris_inspect can map DOM -> file:line
  // (React 19 removed _debugSource). Dev-only; harmless in prod builds.
  plugins: [react({ babel: { plugins: [irisSource] } })],
  server: { port: 4310 },
});
