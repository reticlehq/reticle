/**
 * The front door.
 *
 * A realm for a subject that runs and exits, and the port it needs from the operating system.
 * Nothing here spawns anything: `CliRealm` is given a `Supervisor` and knows the world only
 * through it.
 */
export { CliRealm, CliSummary, closedBy } from './cli-realm.js';
export type { CliRealmDeps } from './cli-realm.js';
export { CliChannel } from './channels.js';
export { NodeSupervisor, exitStatus } from './process/node-supervisor.js';
export { nodeWorkspace } from './workspace/port.js';
export { detectAnomalies } from './detect.js';
export { renderReport } from './report.js';
export { buildRun } from './run.js';
export type { DriveOutcome, RunInput } from './run.js';
export { startConnectProxy } from './net/proxy.js';
export type { ConnectAttempt, ConnectProxy, ConnectProxyInput } from './net/proxy.js';
export type { DriveRecord } from './report.js';
export type { WorkspacePort } from './workspace/port.js';
export {
  ChangeKind,
  diffSnapshots,
  takeSnapshot,
  EXCLUDED_BY_DEFAULT,
} from './workspace/snapshot.js';
export type { Change, FileFact, Snapshot, SnapshotOptions } from './workspace/snapshot.js';
export type { NodeSupervisorInput } from './process/node-supervisor.js';
export { commandNamed } from './manifest.js';
export type { CliCommand, CommandManifest } from './manifest.js';
export type {
  ExitStatus,
  Invocation,
  StreamLine,
  Supervisor,
  ToolIdentity,
} from './process/supervisor.js';
