// One-install Reticle — the dev-only app SDK: in-page instrumentation (@reticle/browser) plus the
// React adapter (@reticle/react). Subpaths: '@reticle/core/next', '/babel', '/test', '/server'.
export * from '@reticle/browser';
export { install, installRenderMeter, identify, readState, hasHoverHandlers } from '@reticle/react';
