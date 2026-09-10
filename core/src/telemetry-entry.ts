/**
 * `@reticlehq/core/telemetry` — the analytics wire contract.
 *
 * The event kinds, their zod schemas, and the two payloads a PERSON writes (feedback + identity).
 * Separate from the root entry point because this is a different wire from the browser↔bridge one:
 * it goes to the capture endpoint, not to the agent. See docs/telemetry-contract.md.
 *
 * Every name below is ALSO exported from the root entry point, which stays as it was.
 */
export * from './telemetry.js';
export * from './words/no-session-reason.js';
export * from './telemetry-refusal.js';
export * from './telemetry-session.js';
export * from './telemetry-license.js';
export * from './telemetry-feedback.js';
