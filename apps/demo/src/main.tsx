import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Agentation } from 'agentation';
import { iris } from '@iris/browser';
import { App } from './App.js';

const isDev = import.meta.env.DEV;

// Dev-only: give the coding agent eyes into this running app.
if (isDev) {
  iris.connect({ session: 'demo' });
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
    {/* Human UI annotations -> agent context (complements Iris). Dev only. */}
    {isDev ? <Agentation /> : null}
  </StrictMode>,
);
