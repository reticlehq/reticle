/**
 * `@reticlehq/core/hooks` — what Reticle says happened, for anyone building on top of it.
 *
 * A subpath rather than a root export for the same measured reason as `./tour`: the SDK imports
 * core's root entry on every page load of every instrumented app, and a hook contract is read by a
 * hook CONSUMER — a script, or a product embedding the daemon — which is a different audience that
 * never runs in the page. Charging every developer's bundle for it would be a cost with no reader.
 */
export * from './hook-events.js';
