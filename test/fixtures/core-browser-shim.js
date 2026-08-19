/**
 * Minimal @reticlehq/core surface for loading a11y.js in a real browser without zod.
 * Integration tests only — not shipped.
 */
export * from '/core/constants.js';
export { asRef } from '/core/brand.js';
export { scrubKnownSecrets, isSensitiveKey } from '/core/redaction.js';
export { DATA_RETICLE_SOURCE_ATTR } from '/core/source-constants.js';
