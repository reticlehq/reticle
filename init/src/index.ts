/**
 * The public surface of the Reticle scaffolder.
 *
 * `@reticlehq/server` is the only consumer today and reaches for a handful of things: the runner
 * and its IO, the framework/package-manager detection its doctor and self-update reuse, the two
 * diagnostics, and the leaf vocabulary (platform names, dev-server ports, the init-failure reasons)
 * that both halves of the old single package shared. One entry point rather than a dozen subpath
 * exports: the module layout inside here is not a contract, and pinning it as one is how a package
 * ends up unable to move a file.
 */

export {
  runInit,
  resolveLockfiles,
  type InitIo,
  type InitOptions,
  type InitResult,
} from './run.js';
export { buildNodeIo } from './node-io.js';
export { type InitHost, SILENT_HOST } from './host.js';
export { RETICLE_VERSION, RETICLE_NPM_PACKAGE } from './version.js';
export { InitFailure } from './diagnose/init-failure.js';
export { NodePlatform } from './detect/platform.js';
export {
  DEV_SERVER_PORTS,
  isLikelyDevServerPort,
  devServerPortWarning,
} from './detect/dev-server-ports.js';
export { configWithInstallSource } from './project/install-source-config.js';
export { projectIdOf, rememberProjectOnDisk, type RegistryIo } from './project/remember-project.js';
export {
  detectPackageManager,
  installCommandParts,
  parseMajor,
  PackageManager,
} from './detect/detect.js';
export { findWorkspaceApps } from './detect/workspace-apps.js';
export { refreshAgentRules } from './project/refresh-rules.js';
export { diagnoseDesktop, isDesktopProject } from './diagnose/desktop-doctor.js';
export { diagnoseWebCsp } from './diagnose/csp-doctor.js';
export { reticleConfigContent } from './patch/snippets.js';
