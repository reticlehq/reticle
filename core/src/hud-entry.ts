/**
 * `@reticlehq/core/hud` — the HUD's control names, for the panel that renders them and the daemon
 * that counts them.
 *
 * A subpath for the reason `./tour` is one: the SDK loads core's root entry on every page, and the
 * control list re-exported from there landed in a chunk every page downloads, though only the lazily
 * loaded panel ever reads it. `first-load-size` measured it.
 */
export * from './wire/constants/hud-controls.js';
