/**
 * `@reticlehq/core/activation` — the activation ticket, for the page loader that checks it and the
 * service that signs it.
 *
 * A subpath for the reason `./hud` is one: the loader runs on every page load of a live site, and
 * core's root entry would put the whole wire contract into it.
 */
export * from './wire/production/activation-ticket.js';
export * from './wire/production/hello-mode.js';
