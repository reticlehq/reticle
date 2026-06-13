import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Agentation } from 'agentation';
import { iris } from '@iris/browser';
import { install as installReactAdapter } from '@iris/react';
import { App } from './App.js';

const isDev = import.meta.env.DEV;

// Dev-only: give the coding agent eyes into this running app.
if (isDev) {
  installReactAdapter(); // DOM ref -> component stack -> source file
  iris.connect({ session: 'demo', present: true }); // presenter: glow + cursor + HUD
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root not found');
}

// Agentation can be toggled off with ?noagentation to keep Iris demos uncluttered.
const showAgentation = isDev && !new URLSearchParams(window.location.search).has('noagentation');

createRoot(rootElement).render(
  <StrictMode>
    <App />
    {/* Human UI annotations -> agent context (complements Iris). Dev only. */}
    {showAgentation ? <Agentation /> : null}
  </StrictMode>,
);
