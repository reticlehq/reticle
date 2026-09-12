import { PlatformProfile, RETICLE_IPC_GLOBAL, ReticleCommand } from '@reticlehq/core';

/**
 * What kind of place this is, and what it can be asked to do.
 *
 * The two remaining halves of the protocol's handshake declaration. Both fields have existed on
 * the wire schema for a while and neither was ever set — the same shape as `channels` before it:
 * a rule written down, a field reserved for it, and nothing on the other end filling it in. A
 * declaration nobody makes is a rule nobody follows.
 */

/** Tauri's bridge object, which exists only inside a Tauri webview. */
const TAURI_INTERNALS_GLOBAL = '__TAURI_INTERNALS__';

/**
 * Which profile this page is running under.
 *
 * Detected rather than configured, because the one thing worse than not declaring a platform is
 * declaring the wrong one: a consumer reading `web` for a Tauri webview will offer advice about
 * browser tabs and dev servers to somebody who has neither.
 *
 * Both desktop runtimes are `webview` and not a profile each. They render with a browser engine
 * and the window around them belongs to something else, which is the entire distinction this
 * value carries — everything that differs beyond that (who owns the camera, what a hidden window
 * does) is a property of the realm, not of the platform, and is answered elsewhere.
 *
 * `native` and `service` are unreachable from here by construction: this SDK needs a `document`.
 * They exist in the enum for implementations that are not this one, which is what an open
 * protocol's enum is for.
 */
export function declaredPlatform(): PlatformProfile {
  if ('undefined' === typeof window) return PlatformProfile.SERVICE;
  const global = window as unknown as Record<string, unknown>;
  // Electron announces itself through the preload channel Reticle installs; Tauri through its own
  // internals object. Neither is spoofable by ordinary page code in a way that matters here --
  // both are installed before app code runs.
  const isDesktop =
    global[RETICLE_IPC_GLOBAL] !== undefined || global[TAURI_INTERNALS_GLOBAL] !== undefined;
  return isDesktop ? PlatformProfile.WEBVIEW : PlatformProfile.WEB;
}

/**
 * The commands this build will actually answer.
 *
 * Declared so a decider can tell, at connect time, which of its requests would be refused —
 * rather than discovering it one spent action at a time. The protocol's own words: a realm
 * declares what it can do and must refuse everything else, and the refusal is only checkable
 * against something.
 *
 * This is a LIST OF WHAT IS HANDLED, not a list of what is desirable. Every name here is
 * dispatched by `#handleCommand`, and a command added to that switch without being added here
 * would be declared unavailable and never asked for — which is the safe direction, and is why
 * the guard beside this file compares the two rather than trusting either.
 */
export const SERVED_COMMANDS: readonly string[] = [
  ReticleCommand.SNAPSHOT,
  ReticleCommand.QUERY,
  ReticleCommand.MATCH,
  ReticleCommand.INSPECT,
  ReticleCommand.ACT,
  ReticleCommand.ACT_SEQUENCE,
  ReticleCommand.ANIMATIONS,
  ReticleCommand.NARRATE,
  ReticleCommand.CLOCK,
  ReticleCommand.CAPABILITIES,
  ReticleCommand.STATE_READ,
  ReticleCommand.STORAGE_READ,
  ReticleCommand.SCROLL,
  ReticleCommand.SESSION_CONFIG,
  ReticleCommand.PRESENTER,
  ReticleCommand.IMPACT,
  ReticleCommand.CAPTURE,
  ReticleCommand.NAVIGATE,
  ReticleCommand.REFRESH,
  // Bridge -> page pushes. Served like any other command, and previously missing from this list,
  // which the guard beside this file caught on its first run.
  ReticleCommand.FLOWS,
];

/**
 * What this build serves, for the handshake.
 *
 * A copy, because the wire shape is mutable and the source of truth here must not be. A caller
 * that could push onto the returned array would be editing what this implementation claims about
 * itself, from the outside, after it had claimed it.
 */
export function declaredCommands(): string[] {
  return [...SERVED_COMMANDS];
}
