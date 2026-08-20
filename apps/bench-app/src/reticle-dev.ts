import { reticle, SESSION_AUTO } from '@reticlehq/browser';
import { install as installReactAdapter } from '@reticlehq/react';
import { registerCapabilities, registerStore, tanstackQueryStore } from '@reticlehq/browser';
import { Sig } from './lib/reticle-bridge.js';
import { useApp } from './store/store.js';
import { queryClient } from './lib/query-client.js';

/**
 * Dev-only Reticle wiring. Wires the proof layer into this running dashboard:
 * - connect opens the presenter (glow + cursor + HUD) and the bridge.
 * - registerStore('app', …) → reticle_state reads the live zustand store (the reliable layer).
 * - registerCapabilities(…) → reticle_capabilities advertises the WHOLE testable surface (testids,
 * signals, store, named flows) so a fresh agent learns what to drive without reading source.
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
  'saved-items-heading',
  'saved-item-input',
  'saved-item-submit',
  'saved-item-list',
  'saved-item-error',
];

const FLOWS = [
  {
    name: 'ship-a-deploy',
    steps: ['nav-deployments', 'new-deploy', 'deploy-name', 'deploy-submit'],
  },
  { name: 'generate-a-script', steps: ['nav-compose', 'compose-prompt', 'compose-generate'] },
  { name: 'find-old-deploy', steps: ['nav-deployments', 'scroll-to row-3600'] },
];

export function installReticle(): void {
  installReactAdapter(); // DOM ref → React fiber → component → source file (reticle_inspect)
  // The presenter HUD (glow + cursor + narration panel) is on by default. Add ?nopresent to
  // suppress it (e.g. for clean screen recordings). Reticle still drives the page either way.
  // Default to a per-tab id (SESSION_AUTO) so several tabs — a human tab + an Reticle-driven tour, a
  // new-tab popup — never collide on one session id. Pass ?session=<id> only when tabs should
  // intentionally share a session.
  const params = new URLSearchParams(window.location.search);
  const present = !params.has('nopresent');
  const session = params.get('session') ?? SESSION_AUTO;
  const reticlePort: number = typeof __RETICLE_PORT__ !== 'undefined' ? __RETICLE_PORT__ : 4400;
  // The daemon requires its pairing token on the websocket hello; vite.config injects it (env wins).
  const injectedToken = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
  const envToken = import.meta.env.VITE_RETICLE_TOKEN;
  const token = 'string' === typeof envToken && envToken.length > 0 ? envToken : injectedToken;
  const configuredUrl = import.meta.env.VITE_RETICLE_WS_URL;
  const url =
    'string' === typeof configuredUrl && configuredUrl.length > 0
      ? configuredUrl
      : `ws://localhost:${reticlePort}/reticle`;
  const allowNonLocalhost = 'true' === import.meta.env.VITE_RETICLE_ALLOW_NON_LOCALHOST;
  reticle.connect({
    session,
    present,
    url,
    // SSE/WebSocket frames are only captured with body capture on — a chatty stream is the
    // high-volume case, so the SDK makes it opt-in. The streams bugs are invisible without it.
    captureNetworkBodies: true,
    ...(allowNonLocalhost ? { allowNonLocalhost: true } : {}),
    ...('string' === typeof token && token.length > 0 ? { token } : {}),
  });
  // Pass the store itself (not a getter) so Reticle wires subscribe too — every mutation emits a
  // STATE_CHANGE path diff, which is what fills `stateDiffs` in the causal summary.
  registerStore('app', useApp);
  // The TanStack Query cache, via the adapter. Registered because server state is where "the screen
  // is plausible and the network is silent" is the NORMAL failure: a mutation that forgets to
  // invalidate leaves the UI rendering a number that was correct a moment ago, and no request fires
  // for anything outside the app to notice. The cache's freshness metadata is the only witness.
  registerStore('queries', tanstackQueryStore(queryClient));
  registerCapabilities({
    testids: TESTIDS,
    signals: Object.values(Sig),
    stores: ['app'],
    flows: FLOWS,
  });
}
