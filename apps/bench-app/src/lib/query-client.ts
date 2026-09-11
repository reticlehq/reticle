import { QueryClient } from '@tanstack/react-query';

/**
 * One QueryClient for the app, created at module scope so the Reticle adapter and the provider are
 * unambiguously looking at the same cache. Retries are off: a benchmark wants a mutation's effect (or
 * the absence of one) to be deterministic, not smeared across background attempts.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

/**
 * Whether the add-item mutation invalidates its query. False under `?reticle-bug=stale-cache-serves-old`.
 * Read from the URL rather than the injector so the flag is available at render time, before any
 * effect runs — the bug has to be present on the first paint, not applied afterwards.
 */
export function invalidatesOnAdd(): boolean {
  const bugs = new URLSearchParams(window.location.search).get('reticle-bug') ?? '';
  return !bugs.split(',').includes('stale-cache-serves-old');
}
