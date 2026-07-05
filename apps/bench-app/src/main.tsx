import './reticle-render-setup.js'; // MUST be first — installs the render meter before react-dom loads
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { installReticle } from './reticle-dev.js';
import { installRegressions } from './reticle-regress.js';
import { installBugInjector } from './reticle-bug-injector.js';
import { installOpaqueShell } from './reticle-opaque.js';

// Dev-only: wire the proof layer into this running dashboard (presenter + capabilities +
// store). Tree-shaken out of production builds.
if (import.meta.env.DEV) {
  installReticle();
  installRegressions(); // no-op unless ?reticle-break=<testids> — controlled regression knob for benchmarks
  installBugInjector(); // no-op unless ?reticle-bug=<ids> — injects UI bugs (computed-style/geometry + state-desync) for the benchmark
  installOpaqueShell(); // no-op unless ?opaque=<1|2> — strips testids (+role/aria) for the opaque-shell metric
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
