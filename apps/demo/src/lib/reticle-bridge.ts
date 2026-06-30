import { reticle } from '@reticle/browser';

/**
 * Named signals the app emits on every meaningful action. These ARE the contract an Reticle agent
 * asserts on (reticle_observe / reticle_wait_for { signal }) — far more reliable than scraping the DOM.
 * Mirrored into the capability registry (reticle-dev.ts) so reticle_capabilities advertises them.
 */
export const Sig = {
  NAV_CHANGED: 'nav:changed',
  AUTH_GRANTED: 'auth:granted',
  AUTH_DENIED: 'auth:denied',
  DEPLOY_CREATED: 'deploy:created',
  DEPLOY_SHIPPED: 'deploy:shipped',
  DEPLOY_REORDERED: 'deploy:reordered',
  DEPLOY_SELECTED: 'deploy:selected',
  FILTER_CHANGED: 'filter:changed',
  MODAL_OPENED: 'modal:opened',
  MODAL_CLOSED: 'modal:closed',
  DRAWER_OPENED: 'drawer:opened',
  COMPOSE_GENERATED: 'compose:generated',
  TITLE_COMMITTED: 'compose:title-committed',
  FAULT_INJECTED: 'fault:injected',
  TOAST_SHOWN: 'toast:shown',
  PALETTE_OPENED: 'palette:opened',
} as const;
export type Sig = (typeof Sig)[keyof typeof Sig];

const isDev = import.meta.env.DEV;

/** Emit an Reticle signal (dev only — tree-shaken/no-op in production). */
export function emit(name: Sig, data: Record<string, unknown> = {}): void {
  if (isDev) reticle.signal(name, data);
}
