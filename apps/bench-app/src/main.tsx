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
  // ?no-hud skips Reticle's SDK + presenter entirely — the app a non-Reticle tool (e.g. Playwright)
  // would actually face, with NO HUD overlay to fight. The bug injector still runs, so the same bug
  // is present; only Reticle's own instrumentation is absent. (Reticle-MCP uses the normal build.)
  const noHud = new URLSearchParams(window.location.search).has('no-hud');
  if (!noHud) installReticle(); // presenter (glow+cursor+HUD) + capabilities + store registration
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
