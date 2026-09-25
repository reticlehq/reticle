/**
 * @reticlehq/core — the wire contract at the bottom of the Reticle graph (zod its only dependency).
 *
 * API-stability note: the exports below the divider are INTERNAL cross-package plumbing — they are
 * cross-package plumbing so the other @reticlehq/* packages share one implementation, NOT a stable surface
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
 * @reticlehq/browser fails if adapters/realm/browser/src imports any artifacts-group name from
 * '@reticlehq/core'. That test, not this comment, is what keeps the DOM side off the Node-side
 * plumbing.
 */

// ── STABLE public surface: the wire/domain contract ──────────────────────────────────────────────
export * from './artifacts/flow-order.js'; // orderFlows — prerequisites first, cycles reported
export * from './artifacts/flow-select.js'; // selectFlows — which flows a run replays, and what it held back
export * from './artifacts/flow-unreached.js'; // unreachedRoutes — known routes this run never visited
export * from './artifacts/flow-mutation-target.js'; // what a flow says it depends on: mutationTargetsFor + perturbationFor
export * from './wire/constants/constants.js'; // EventType, ActionType, wire constants, TRANSPORT_LIMITS, …
export * from './identity/source-constants.js'; // DATA_RETICLE_SOURCE_ATTR, RETICLE_ROOT_GLOBAL
export * from './wire/event-classification.js'; // CHURN_TYPES — shared eviction priority for buffer/queue
export * from './wire/global-press.js'; // which press is a document key (Escape / Tab / a shortcut)
export * from './verdict/verified-constants.js'; // Verified — the one field an agent gates on
// Its own module so a page that never needs it does not download it — see first-load-size.
export * from './verdict/verdict-attribution.js';
export * from './verdict/verify-progress.js'; // VerifyPhase — what a run is doing while it is still doing it
export * from './wire/constants/session-constants.js';
export * from './wire/constants/hud-use.js'; // where the HUD sits, for HUD_USED events
export * from './wire/constants/discovery.js'; // the call-the-founder invitation, one link for every surface
export * from './identity/document-identity.js'; // which document an observation belongs to
export * from './identity/edit-epoch.js'; // which round of source edits an observation belongs to
export * from './wire/messages.js'; // ReticleEvent + the message schemas
export * from './wire/event-payloads.js'; // per-event payload schemas + wire vocab
export * from './wire/event-priority.js'; // which events survive the bridge rate cap
export * from './artifacts/flow-constants.js'; // moved off wire/constants/constants, which had no use for them
/*
 * The leaf FIRST, and separately from the file it describes. `flow-step-tool.ts` was extracted out
 * of `flow-types.ts` precisely so the browser SDK — which imports `FlowStepTool` and nothing else
 * from there — would stop downloading eleven zod schemas it can never use. `flow-types.ts` then
 * re-exported the two names for convenience, which put the whole module straight back on the
 * barrel's path to them and quietly undid the extraction: measured at 6,222 B of every page load,
 * reached through one constant.
 *
 * That is the same shape as the z-index that dragged the panel's stylesheet in, and as `StepEffect`
 * on the line below. A leaf is only a leaf if the barrel names it directly.
 */
export * from './artifacts/flow-step-tool.js'; // FlowStepTool / CROSS_STEP_ADDRESS: a leaf, named directly
export * from './artifacts/flow-types.js'; // FlowStep, FlowExpect, replay result shapes
export * from './artifacts/step-effect.js'; // StepEffect: a leaf, so the page never downloads it
export * from './artifacts/flow-composition.js'; // canFollow: may B replay straight after A
export * from './verdict/verification-run.js'; // run/verdict shapes for the CI surface
export * from './wire/types.js';
export * from './identity/brand.js'; // RunId / SessionId / ProjectId / Ref brands + validators
export * from './wire/net.js'; // NetInitiator / ipc:// scheme — network + desktop-IPC call vocabulary
export * from './verdict/findings.js'; // crawl anomalies + cross-channel contradictions
export * from './wire/desktop-contract.js'; // the Electron preload/main/renderer/daemon string contract
export * from './verdict/consequence.js';
// The predicate CONTRACT: what a caller may declare, and what a saved flow may carry. The engine
// owns the reasoning over it and re-exports both halves as one surface.
export * from './verdict/property-assertion.js';
export * from './verdict/predicate.js';
export * from './verdict/predicate-tree.js';
// The version 1 reader: a flat expect lifted to the predicate a v2 file stores directly.
export * from './artifacts/flow-expect-flat.js';
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
export * from './words/no-session-reason.js';
export * from './telemetry-refusal.js';
export * from './wire/narrow.js';
export * from './wire/tool-names.js';
export * from './wire/snapshot-tree.js'; // parseInteractive — the browser writes this format, Node reads it
export * from './wire/platform.js';
export * from './wire/channel.js';
export * from './verdict/revision.js';
export * from './realm/registry.js';
// The protocol is NOT re-exported here, deliberately.
//
// `open-verification` is the specification this codebase implements, and it is a separate
// package precisely so that somebody implementing it does not have to install the product. Blanket
// re-exporting it from core erases that line: a consumer reaches a protocol name through Reticle
// and now depends on Reticle for a contract that was written not to need it. Import the protocol
// from the protocol. What core re-exports are the few names this repository has always spelled its
// own way -- see wire/channel.ts, which imports the rule rather than restating it.
export * from './telemetry-session.js'; // the session/project rollup payloads
export * from './telemetry-license.js'; // LicenseActivation — shared by the licence gate and telemetry
export * from './telemetry-feedback.js'; // the two things a PERSON writes: feedback + a self-declared identity
export * from './artifacts/impact.js'; // the user's own record of what Reticle has done for them (local only)
export * from './artifacts/impact-savings.js'; // the savings model - one file, so every claim is derivable there
export {
  CONTRACT_FINGERPRINT,
  CONTRACT_PARTS,
  fnv1a,
  fingerprintOf,
} from './identity/contract-fingerprint.js';
export { fingerprintFinding, type FindingIdentity } from './verdict/finding-fingerprint.js';
export * from './words/unreachable-notice.js'; // the page's unreachable warning, as a contract the daemon parses
