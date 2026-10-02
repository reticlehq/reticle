/**
 * `@reticlehq/core/tour` — the onboarding tour, for the two surfaces that render it.
 *
 * A subpath rather than a root export, and the reason is measurable: the SDK imports core's root
 * entry on every page load, so putting the tour's prose there charged ~2 kB to every developer on
 * every load of every app, including the ones where nobody ever sees a tour. `first-load-size`
 * caught it immediately. The same reasoning as `./telemetry`: a different audience is a different
 * entry point.
 */
export * from './tour.js';
