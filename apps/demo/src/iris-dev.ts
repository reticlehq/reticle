import { iris } from '@syrin/iris-browser';
import { install as installReactAdapter } from '@syrin/iris-react';
import { registerCapabilities, registerStore } from '@syrin/iris-browser';
import { Sig } from './lib/iris-bridge.js';
import { useApp } from './store/store.js';

/**
 * Dev-only Iris wiring. Gives a coding agent EYES into this running dashboard:
 *  - connect() opens the presenter (glow + cursor + HUD) and the bridge.
 *  - registerStore('app', …) → iris_state reads the live zustand store (the reliable layer).
 *  - registerCapabilities(…) → iris_capabilities advertises the WHOLE testable surface (testids,
 *    signals, store, named flows) so a fresh agent learns what to drive without reading source.
 * Tree-shaken out of production; never imported there.
 */

const TESTIDS = [
  // shell + nav
  'brand',
  'cmdk-open',
  'nav-overview',
  'nav-deployments',
  'nav-compose',
  'nav-diagnostics',
  'session-pill',
  'palette',
  'palette-input',
  // login
  'login-email',
  'login-password',
  'login-submit',
  'login-error',
  // overview
  'kpi-deploys',
  'kpi-success',
  'kpi-p95',
  'kpi-services',
  'area-chart',
  'activity-feed',
  // deployments
  'deploy-table',
  'deploy-list',
  'filter-search',
  'env-filter',
  'env-menu',
  'new-deploy',
  'deploy-modal',
  'deploy-name',
  'deploy-env-select',
  'deploy-submit',
  'deploy-cancel',
  'row-menu-trigger',
  'row-menu',
  'ship-action',
  'open-detail-action',
  'drawer',
  'drawer-close',
  // compose
  'compose-title',
  'compose-prompt',
  'compose-generate',
  'compose-result',
  'compose-source',
  // diagnostics
  'fault-404',
  'fault-500',
  'fault-cors',
  'fault-wrong-format',
  'fault-wrong-data',
  'fault-buggy',
  'request-log',
  'console-count',
];

const FLOWS = [
  {
    name: 'ship-a-deploy',
    steps: ['nav-deployments', 'new-deploy', 'deploy-name', 'deploy-submit'],
  },
  { name: 'generate-a-script', steps: ['nav-compose', 'compose-prompt', 'compose-generate'] },
  { name: 'find-old-deploy', steps: ['nav-deployments', 'scroll-to row-3600'] },
];

export function installIris(): void {
  installReactAdapter(); // DOM ref → React fiber → component → source file (iris_inspect)
  // The presenter HUD (glow + cursor + narration panel) is opt-in via ?present so the dashboard
  // stays clean for filming. Iris still drives the page either way; add ?present to show the agent.
  const present = new URLSearchParams(window.location.search).has('present');
  iris.connect({ session: 'demo', present });
  registerStore('app', () => useApp.getState());
  registerCapabilities({
    testids: TESTIDS,
    signals: Object.values(Sig),
    stores: ['app'],
    flows: FLOWS,
  });
}
