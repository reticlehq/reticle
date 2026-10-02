/**
 * Classified `reticle init` failures — our own vocabulary, never a raw error or a path.
 *
 * Lives here rather than beside the telemetry client because `run.ts` is what classifies a failed
 * run, and `@reticlehq/init` must not depend on the daemon.
 */
export const InitFailure = {
  /** Run outside a project root. The single most common first-run mistake. */
  NO_PACKAGE_JSON: 'no_package_json',
  /** The manifest exists and is not valid JSON — a trailing comma, usually. Never a stack trace. */
  MALFORMED_PACKAGE_JSON: 'malformed_package_json',
  /** The package manager failed: offline, a locked registry, a broken install. */
  DEPENDENCY_INSTALL: 'dependency_install',
  /** The `claude mcp add` step failed — the CLI is missing or refused. Reticle installs but is unreachable. */
  MCP_REGISTRATION: 'mcp_registration',
  /** The checkout or required tooling failed preflight. */
  PREFLIGHT: 'preflight',
  /** Runtime continuation could not start the app or connect its SDK. */
  DEV_SERVER: 'dev_server',
  APP_CONNECTION: 'app_connection',
  BRIDGE_OCCUPIED: 'bridge_occupied',
  RUNTIME_ERROR: 'runtime_error',
  OTHER: 'other',
} as const;
export type InitFailure = (typeof InitFailure)[keyof typeof InitFailure];
