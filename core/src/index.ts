/**
 * @reticlehq/core — the wire contract at the bottom of the Reticle graph (zod its only dependency).
 *
 * API-stability note: the exports below the divider are INTERNAL cross-package plumbing — they are
 * re-exported so the other @reticlehq/* packages can share one implementation, NOT as a stable surface
 * for outside consumers. They can change in a minor release. Depend on the STABLE section for anything
 * outside this monorepo.
 *
 * Two of those internal groups now have their own entry points, so a Node-side importer can name the
 * half of core it depends on instead of pulling the whole surface:
 *
 *   - `@reticlehq/core/artifacts`  — on-disk + registry formats (see ./artifacts-entry.ts)
 *   - `@reticlehq/core/telemetry`  — the analytics wire (see ./telemetry-entry.ts)
 *
 * This root entry point still exports everything it did before — the subpaths are additive, and
 * removing a name from here would be a breaking change to a published package. The boundary that is
 * actually ENFORCED is the one the browser SDK must not cross: `core-boundary.test.ts` in
 * @reticlehq/browser fails if adapters/realm/dom/src imports any artifacts-group name from
 * '@reticlehq/core'. That test, not this comment, is what keeps the DOM side off the Node-side
 * plumbing.
 */

// ── STABLE public surface: the wire/domain contract ──────────────────────────────────────────────
export * from './wire/constants.js'; // EventType, ActionType, wire constants, TRANSPORT_LIMITS, …
export * from './identity/source-constants.js'; // DATA_RETICLE_SOURCE_ATTR, RETICLE_ROOT_GLOBAL
export * from './wire/event-classification.js'; // CHURN_TYPES — shared eviction priority for buffer/queue
export * from './verdict/verified-constants.js'; // Verified — the one field an agent gates on
export * from './verdict/verify-progress.js'; // VerifyPhase — what a run is doing while it is still doing it
export * from './wire/session-constants.js';
export * from './identity/document-identity.js'; // which document an observation belongs to
export * from './identity/edit-epoch.js'; // which round of source edits an observation belongs to
export * from './wire/messages.js'; // ReticleEvent + the message schemas
export * from './wire/event-payloads.js'; // per-event payload schemas + wire vocab
export * from './wire/event-priority.js'; // which events survive the bridge rate cap
export * from './artifacts/flow-types.js'; // FlowStep, FlowExpect, FlowStepTool, replay result shapes
export * from './verdict/verification-run.js'; // run/verdict shapes for the CI surface
export * from './wire/types.js';
export * from './identity/brand.js'; // RunId / SessionId / Ref brands + validators
export * from './wire/net.js'; // NetInitiator / ipc:// scheme — network + desktop-IPC call vocabulary
export * from './verdict/findings.js'; // crawl anomalies + cross-channel contradictions
export * from './wire/desktop-contract.js'; // the Electron preload/main/renderer/daemon string contract
export * from './verdict/consequence.js';
export * from './identity/project-id.js';
export * from './words/notices.js';
export * from './artifacts/journal.js';
// Not an API — three names that exist so importing the BROWSER SDK from here fails with a sentence
// naming @reticlehq/browser, instead of a bare SyntaxError that blanks the app. See the module.
export * from './words/browser-misdirect.js';

// ── INTERNAL cross-package plumbing (shared impl; not a stable outside API — may change in a minor) ─
export * from './registry/daemon-registry.js'; // daemon discovery, used by the vite plugin + server
export * from './registry/dev-server-registry.js'; // the return leg: dev servers announcing themselves
export * from './registry/project-registry.js'; // projectId -> directory, so a cross-repo daemon can still resolve
export * from './verdict/intent.js'; // what a change was supposed to make true, captured while somebody knows
export * from './verdict/run-context.js'; // what a run established, folded and capped, for the agent to pull back
export * from './verdict/instrumentation-gap.js'; // what Reticle could not see, and the change that would let it
export * from './verdict/security.js'; // sanitize/serialize helpers shared by browser + server
export * from './wire/redaction.js'; // isSensitiveKey / scrubKnownSecrets — the shared redaction rules
export * from './wire/state-select.js'; // selectPath / capDepth — shared by browser SDK + server fallback
export * from './wire/toon.js'; // TOON encoding used by the server's result encoder
export * from './words/upgrade.js'; // self-update policy shared by the CLI
export * from './telemetry.js';
// Split out of telemetry.js at the 1000-line cap; the barrel keeps the import path callers use.
export * from './words/no-session-reason.js';
export * from './telemetry-refusal.js';
export * from './wire/narrow.js';
export * from './wire/tool-names.js';
export * from './wire/platform.js';
export * from './wire/channel.js';
export * from './realm/registry.js';
export * from '@reticlehq/openreality';
export * from './telemetry-session.js'; // the session/project rollup payloads
export * from './telemetry-license.js'; // LicenseActivation — shared by the licence gate and telemetry
export * from './telemetry-feedback.js'; // the two things a PERSON writes: feedback + a self-declared identity // anonymous adoption telemetry wire contract (DAU/WAU/MAU/installs)
export * from './artifacts/impact.js'; // the user's own record of what Reticle has done for them (local only)
export * from './artifacts/impact-savings.js'; // the savings model - one file, so every claim is derivable there
export { CONTRACT_FINGERPRINT, fnv1a, fingerprintOf } from './identity/contract-fingerprint.js';
export { fingerprintFinding, type FindingIdentity } from './verdict/finding-fingerprint.js';
export * from './words/unreachable-notice.js'; // the page's unreachable warning, as a contract the daemon parses
