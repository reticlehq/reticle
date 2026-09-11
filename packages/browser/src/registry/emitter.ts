/**
 * The injected-emitter pattern (P5a): host-app components depend on a tiny structural interface
 * instead of importing the SDK directly. The real emitter proxies to the connected `reticle`
 * singleton; when Reticle isn't connected (or isn't loaded) every call is a SAFE NO-OP — so nothing
 * breaks in production or before `reticle.connect`, and `@reticlehq/browser` stays out of the prod bundle.
 */

import { reticle } from '../index.js';

/** Structural emitter the host app's components depend on. */
export interface ReticleEmitter {
  // Function-typed PROPERTIES rather than method shorthand, deliberately. Every implementation is a
  // closure or a test double; none of them reads `this`, and method syntax claims a receiver they do
  // not have. Saying so in the type is both more accurate and what lets a caller hold one of these
  // (`expect(emitter.signal)`) without it reading as a method torn off its object.
  signal: (name: string, data?: Record<string, unknown>) => void;
  state: (name: string, value: unknown) => void;
}

/** The subset of the reticle singleton an emitter proxies to (lets tests inject a fake). */
export interface EmitterTarget {
  signal(name: string, data?: Record<string, unknown>): void;
  state(name: string, value: unknown): void;
  /** Discriminator the emitter reads per call to decide forward-vs-no-op. */
  readonly connected: boolean;
}

export interface CreateReticleEmitterOptions {
  /** Override the proxy target (tests / advanced embedding). Defaults to the reticle singleton. */
  target?: EmitterTarget;
}

/**
 * Create an emitter. Reads `target.connected` on EVERY call (not at creation) so an emitter
 * made at module load — before `reticle.connect` — starts working the moment Reticle connects.
 */
export function createReticleEmitter(options: CreateReticleEmitterOptions = {}): ReticleEmitter {
  const target: EmitterTarget = options.target ?? reticle;
  return {
    signal(name: string, data: Record<string, unknown> = {}): void {
      if (!target.connected) return;
      target.signal(name, data);
    },
    state(name: string, value: unknown): void {
      if (!target.connected) return;
      target.state(name, value);
    },
  };
}
