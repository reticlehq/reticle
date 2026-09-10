/**
 * `@reticlehq/core/artifacts` — the on-disk and registry formats.
 *
 * Nothing here crosses the browser↔bridge wire. These are files the CLI, the bridge and the vite
 * plugin read and write on the developer's machine: the `.reticle/` journal, the intent ledger, the
 * run context, the daemon/dev-server/project registries, the self-update policy, and the
 * instrumentation gaps the server reports back.
 *
 * Every name below is ALSO exported from the root entry point, which stays as it was — this path
 * exists so a Node-side importer can say which half of core it depends on, and so
 * `core-boundary.test.ts` in @reticlehq/browser can fail when the DOM side reaches for one of them.
 */
export * from '../registry/daemon-registry.js';
export * from '../registry/dev-server-registry.js';
export * from '../registry/project-registry.js';
export * from '../verdict/intent.js';
export * from '../verdict/run-context.js';
export * from '../verdict/instrumentation-gap.js';
export * from '../words/upgrade.js';
export * from './journal.js';
