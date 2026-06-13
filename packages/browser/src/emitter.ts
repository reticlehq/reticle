/**
 * The injected-emitter pattern (P5a): host-app components depend on a tiny structural interface
 * instead of importing the SDK directly. The real emitter proxies to the connected `iris`
 * singleton; when Iris isn't connected (or isn't loaded) every call is a SAFE NO-OP — so nothing
 * breaks in production or before `iris.connect()`, and `@syrin/browser` stays out of the prod bundle.
 */

import { iris } from './index.js';

/** Structural emitter the host app's components depend on. */
export interface IrisEmitter {
  signal(name: string, data?: Record<string, unknown>): void;
  state(name: string, value: unknown): void;
}

/** The subset of the iris singleton an emitter proxies to (lets tests inject a fake). */
export interface EmitterTarget {
  signal(name: string, data?: Record<string, unknown>): void;
  state(name: string, value: unknown): void;
  /** Discriminator the emitter reads per call to decide forward-vs-no-op. */
  readonly connected: boolean;
}

export interface CreateIrisEmitterOptions {
  /** Override the proxy target (tests / advanced embedding). Defaults to the iris singleton. */
  target?: EmitterTarget;
}

/**
 * Create an emitter. Reads `target.connected` on EVERY call (not at creation) so an emitter
 * made at module load — before `iris.connect()` — starts working the moment Iris connects.
 */
export function createIrisEmitter(options: CreateIrisEmitterOptions = {}): IrisEmitter {
  const target: EmitterTarget = options.target ?? iris;
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
