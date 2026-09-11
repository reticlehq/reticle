import type { ReticleSpec } from './types.js';

/** Module-level registration list. A list (not a map) so duplicate names are kept, not collapsed. */
const specs: ReticleSpec[] = [];

export function register(spec: ReticleSpec): void {
  specs.push(spec);
}

/** A frozen snapshot copy so a run that started can ignore later (re-entrant) registrations. */
export function getRegistered(): readonly ReticleSpec[] {
  return [...specs];
}

export function clearRegistry(): void {
  specs.length = 0;
}
