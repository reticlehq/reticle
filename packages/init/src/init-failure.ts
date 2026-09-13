/**
 * Classified `reticle init` failures — our own vocabulary, never a raw error or a path.
 *
 * Lives here rather than beside the telemetry client because `run.ts` is what classifies a failed
 * run, and `@reticlehq/init` must not depend on the daemon. `@reticlehq/server`'s
 * `telemetry/init-telemetry.ts` re-exports it, so every existing consumer is unchanged.
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
  OTHER: 'other',
} as const;
export type InitFailure = (typeof InitFailure)[keyof typeof InitFailure];
