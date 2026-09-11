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
export { InitFailure } from './init-failure.js';
export { NodePlatform } from './platform.js';
export {
  DEV_SERVER_PORTS,
  isLikelyDevServerPort,
  devServerPortWarning,
} from './dev-server-ports.js';
export { configWithInstallSource } from './install-source-config.js';
export { projectIdOf, rememberProjectOnDisk, type RegistryIo } from './remember-project.js';
export { detectPackageManager, installCommandParts, parseMajor, PackageManager } from './detect.js';
export { findWorkspaceApps } from './workspace-apps.js';
export { refreshAgentRules } from './refresh-rules.js';
export { diagnoseDesktop, isDesktopProject } from './desktop-doctor.js';
export { diagnoseWebCsp } from './csp-doctor.js';
export { reticleConfigContent } from './snippets.js';
