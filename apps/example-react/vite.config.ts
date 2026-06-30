import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/core/vite';

// One line wires Reticle: the plugin stamps a projectId, injects reticle.connect(), and source-maps JSX.
export default defineConfig({ plugins: [reticle(), react()], server: { port: 5301 } });
