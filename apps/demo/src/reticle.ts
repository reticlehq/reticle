// Dev-only signal helper. App code calls signal() freely; in a production build
// import.meta.env.DEV is statically false, so the dynamic import() is dead-code-eliminated
// and the Reticle SDK never enters the bundle. Never import `reticle` from @reticlehq/react
// directly in app code — a static import ships the whole SDK to production.
export function signal(name: string, data?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  void import('@reticlehq/react').then(({ reticle }) => reticle.signal(name, data));
}
