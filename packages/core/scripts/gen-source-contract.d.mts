// Types for the untyped generator, mirroring scripts/gen-desktop-contract.d.mts — the repo's
// existing convention for a build script that a test needs to import.

/** Render the CommonJS module text for a `name → value` record of contract constants. */
export function renderSourceContract(contract: Readonly<Record<string, string>>): string;

/** Render the CJS type declaration (.d.cts) for a `name → value` record. */
export function renderSourceContractDts(contract: Readonly<Record<string, string>>): string;
