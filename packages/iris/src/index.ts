// One-install Iris — the dev-only app SDK: in-page instrumentation (@syrin/browser) plus the
// React adapter (@syrin/react). Subpaths: '@syrin/iris/next', '/babel', '/test', '/server'.
export * from '@syrin/browser';
export { install, identify, readState, hasHoverHandlers } from '@syrin/react';
