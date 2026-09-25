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
/**
 * Exported for the ONE other place in this repo that spawns a package manager: `reticle update`.
 *
 * It is a pure string rule with its own tests, and it was private while a second caller needed it
 * -- which is exactly the shape that let `reticle setup mcp` reimplement the spawn as a bare
 * `execFileSync` and break on Windows. Two copies of a quoting rule is the version of this bug that
 * is hardest to see, so there is one.
 */
export { windowsShellArg } from './register/windows-quote.js';

export { buildNodeIo, probeCli } from './node-io.js';
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
export { deriveProjectId, packageName } from './project/project-id.js';
export { refreshAgentRules } from './project/refresh-rules.js';
export { diagnoseDesktop, isDesktopProject } from './diagnose/desktop-doctor.js';
export {
  CspBasis,
  diagnoseObservedWebCsp,
  diagnoseWebCsp,
  resolveWebCspFindings,
  type CspDiagnosis,
  type ObservedWebDocument,
} from './diagnose/csp-doctor.js';
export { reticleConfigContent } from './patch/snippets.js';

/**
 * MCP registration, for a caller that has no project.
 *
 * `reticle setup mcp` registers the server for the USER across every agent on the machine, which is
 * what the one-line installer runs before any project exists. It needs the same client table and
 * the same detection `init` uses — a second copy would be a second answer to "which agents are
 * here", and the two would disagree the first time a client was added to one of them.
 */
export {
  McpClient,
  ConfigScope,
  MCP_CLIENTS,
  ClientMergeStatus,
  clientSpec,
  mergeClientConfig,
} from './register/mcp-clients.js';
export {
  claudeAddCommand,
  // The two probes `run.ts` uses to decide about Claude Code. Exported because `reticle setup mcp`
  // asks the same question and had no way to ask it: Claude Code keeps no config file, so the
  // file-reading detector cannot see it, and the installer silently skipped the commonest client.
  claudeAvailableProbe,
  claudeExistsProbe,
} from './register/mcp.js';
export { detectMcpClients, type DetectedClient } from './register/detect-clients.js';
