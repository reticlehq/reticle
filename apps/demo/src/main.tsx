import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { installIris } from './iris-dev.js';
import { installRegressions } from './iris-regress.js';
import { installBugInjector } from './iris-bug-injector.js';

// Dev-only: give the coding agent eyes into this running dashboard (presenter + capabilities +
// store). Tree-shaken out of production builds.
if (import.meta.env.DEV) {
  installIris();
  installRegressions(); // no-op unless ?iris-break=<testids> — controlled regression knob for benchmarks
  installBugInjector(); // no-op unless ?iris-bug=<ids> — injects UI bugs (computed-style/geometry + state-desync) for the benchmark
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
