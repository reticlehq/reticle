// One-install Iris — the dev-only app SDK: in-page instrumentation (@syrin/iris-browser) plus the
// React adapter (@syrin/iris-react). Subpaths: '@syrin/iris/next', '/babel', '/test', '/server'.
export * from '@syrin/iris-browser';
export {
  install,
  installRenderMeter,
  identify,
  readState,
  hasHoverHandlers,
} from '@syrin/iris-react';
