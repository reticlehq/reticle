// Types for the untyped generator, mirroring scripts/gen-schema.d.mts — the repo's existing
// convention for a build script that a test needs to import.

/** Render the CommonJS module text for a `name → value` record of contract constants. */
export function renderDesktopContract(contract: Readonly<Record<string, string>>): string;
