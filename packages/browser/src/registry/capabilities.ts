/** Self-describing capability registry — the testable surface the app advertises. */

export interface CapabilityFlow {
  name: string;
  steps: string[];
}

export interface Capabilities {
  testids: string[];
  signals: string[];
  stores: string[];
  flows: CapabilityFlow[];
}

/** What the host app passes to reticle.describe(); all fields optional. */
export interface CapabilitiesInput {
  testids?: string[];
  signals?: string[];
  stores?: string[];
  flows?: CapabilityFlow[];
}

// Persist on a global so the registry survives HMR module re-evaluation (matches __reticleAdapters).
const globalStore = globalThis as unknown as { __reticleCapabilities?: Capabilities };

function empty(): Capabilities {
  return { testids: [], signals: [], stores: [], flows: [] };
}

const capabilities: Capabilities = (globalStore.__reticleCapabilities ??= empty());

function mergeUnique(into: string[], add: readonly string[] | undefined): void {
  if (add === undefined) return;
  for (const v of add) if (!into.includes(v)) into.push(v);
}

/** Called by the host app via reticle.describe(). Merges (idempotent), never replaces wholesale. */
export function registerCapabilities(input: CapabilitiesInput): void {
  mergeUnique(capabilities.testids, input.testids);
  mergeUnique(capabilities.signals, input.signals);
  mergeUnique(capabilities.stores, input.stores);
  if (input.flows !== undefined) {
    for (const flow of input.flows) {
      const existing = capabilities.flows.find((f) => f.name === flow.name);
      if (existing === undefined) {
        capabilities.flows.push({ name: flow.name, steps: [...flow.steps] });
      } else {
        existing.steps = [...flow.steps]; // last writer wins for a named flow
      }
    }
  }
}

/** Snapshot copy of the registered capabilities (defensive — never hand out the live arrays). */
export function getCapabilities(): Capabilities {
  return {
    testids: [...capabilities.testids],
    signals: [...capabilities.signals],
    stores: [...capabilities.stores],
    flows: capabilities.flows.map((f) => ({ name: f.name, steps: [...f.steps] })),
  };
}

/** Whether the app has advertised any capabilities (used in the HELLO flag). */
export function hasCapabilities(): boolean {
  return (
    capabilities.testids.length > 0 ||
    capabilities.signals.length > 0 ||
    capabilities.stores.length > 0 ||
    capabilities.flows.length > 0
  );
}
