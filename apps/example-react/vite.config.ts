import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { iris } from '@syrin/iris/vite';

// One line wires Iris: the plugin stamps a projectId, injects iris.connect(), and source-maps JSX.
export default defineConfig({ plugins: [iris(), react()], server: { port: 5301 } });
