/**
 * The daemon port `reticle init` wires a project to.
 *
 * Init used to leave this unset, so every project on a machine was wired to the default port. The
 * second one to run was connected to the first one's daemon, and the bridge refused its app. When a
 * daemon for another project already holds the default, the new project gets its own port, and init
 * records it in `.reticle.json`, where the CLI and the build plugins both read it.
 *
 * Undefined means the default.
 */
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';

export async function portForInit(
  explicit: number | undefined,
  configured: number | undefined,
  projectId: string | undefined,
  deps: {
    /** The projects the daemon on `port` belongs to or is serving right now. */
    daemonProjects: (port: number) => Promise<readonly string[]>;
    daemonPresent: (port: number) => Promise<boolean>;
    pickPort: (preferred: number) => Promise<number>;
  },
): Promise<number | undefined> {
  if (explicit !== undefined) return explicit;
  if (configured !== undefined) return configured;
  // Undefined, not the default's number: an explicit default would be written into every generated
  // config as a `port` nobody chose.
  if (!(await deps.daemonPresent(RETICLE_DEFAULT_PORT))) return undefined;
  // The bridge's own rule: it refuses a page only when it has served exactly ONE other project. A
  // daemon serving nobody, several projects, or ours accepts this one. A project that has never
  // been through init has no id yet, so a single named holder is somebody else.
  const holders = await deps.daemonProjects(RETICLE_DEFAULT_PORT);
  if (1 !== holders.length || holders[0] === projectId) return undefined;
  return deps.pickPort(RETICLE_DEFAULT_PORT + 1);
}
