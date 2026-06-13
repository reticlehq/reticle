import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { installIris } from './iris-dev.js';

// Dev-only: give the coding agent eyes into this running dashboard (presenter + capabilities +
// store). Tree-shaken out of production builds.
if (import.meta.env.DEV) installIris();

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
