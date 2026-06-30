// One-install Reticle — the dev-only app SDK: in-page instrumentation (@reticlehq/browser) plus the
// React adapter (@reticlehq/react). Subpaths: '@reticlehq/core/next', '/babel', '/test', '/server'.
export * from '@reticlehq/browser';
export {
  install,
  installRenderMeter,
  identify,
  readState,
  hasHoverHandlers,
} from '@reticlehq/react';
