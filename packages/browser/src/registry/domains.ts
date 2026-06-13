/**
 * P5c — self-registering domains. Instead of one hand-maintained flat-map of the whole testable
 * surface, each app domain co-locates its `{ testids, signals, stores }` and calls
 * `registerIrisDomain(...)`; the capability registry assembles itself from every domain. Thin
 * adapter over `registerCapabilities`, so merge/dedupe (and HMR persistence) are reused, not
 * reinvented — later calls accumulate as a union, empty domains are a no-op.
 */

import { registerCapabilities, type CapabilitiesInput } from './capabilities.js';

/** A co-located domain bundle (one `iris.ts` per app domain). */
export interface IrisDomain {
  testids?: readonly string[];
  signals?: readonly string[];
  stores?: readonly string[];
}

export function registerIrisDomain(domain: IrisDomain): void {
  const input: CapabilitiesInput = {};
  if (domain.testids !== undefined) input.testids = [...domain.testids];
  if (domain.signals !== undefined) input.signals = [...domain.signals];
  if (domain.stores !== undefined) input.stores = [...domain.stores];
  registerCapabilities(input);
}
