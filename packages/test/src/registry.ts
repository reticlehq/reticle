import type { IrisSpec } from './types.js';

/** Module-level registration list. A list (not a map) so duplicate names are kept, not collapsed. */
const specs: IrisSpec[] = [];

export function register(spec: IrisSpec): void {
  specs.push(spec);
}

/** A frozen snapshot copy so a run that started can ignore later (re-entrant) registrations. */
export function getRegistered(): readonly IrisSpec[] {
  return [...specs];
}

export function clearRegistry(): void {
  specs.length = 0;
}
