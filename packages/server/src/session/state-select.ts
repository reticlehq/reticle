/**
 * reticle_state path selection + depth capping. The pure implementation now lives in
 * `@reticle/protocol` so the BROWSER SDK can apply it BEFORE the transport (scoping a huge store
 * without paying the truncation tax); the server re-exports it for its back-compat fallback path
 * (an older browser that returns the whole store) and for the predicate engine's `state` assertion.
 */
export { selectPath, capDepth, type PathSelection } from '@reticle/protocol';
