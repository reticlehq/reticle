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
import { relative, isAbsolute } from 'node:path';
import { RETICLE_DEFAULT_PORT, ReticleEnv } from '@reticlehq/core';

const MAX_PORT = 65_535;
/** Ports a project moved off the default may get: above it, and below the 5000s dev servers use. */
const PROJECT_PORT_FIRST = RETICLE_DEFAULT_PORT + 1;
const PROJECT_PORT_SPAN = 599;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The port a project asks for when the default is somebody else's: its own, from its id (or its
 * directory, before it has one), the same on every run. Every project used to ask for the default
 * plus one, so with the first one's daemon not yet running every later project was written the same
 * port and shared it. Taken ports are still skipped by the caller's `pickPort`.
 */
export function projectPortFor(seed: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), FNV_PRIME);
  return PROJECT_PORT_FIRST + ((hash >>> 0) % PROJECT_PORT_SPAN);
}

/**
 * `RETICLE_PORT`, when it names a port. The one reader of it for the CLI, `init` included.
 *
 * `init` took only `--port`, so a shell that exported RETICLE_PORT got a project wired, and a daemon
 * started, on the default port while every other command it ran dialled the exported one. Fed to
 * `portForInit` as the explicit port, so the files phase writes it into `.reticle.json` and the
 * runtime phase binds it: the two halves of `init` cannot disagree.
 */
export function portFromEnv(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env[ReticleEnv.PORT];
  if (undefined === raw || !/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  return 0 < port && port <= MAX_PORT ? port : undefined;
}

export async function portForInit(
  explicit: number | undefined,
  configured: number | undefined,
  projectId: string | undefined,
  deps: {
    /** The projects the daemon on `port` belongs to or is serving right now. */
    daemonProjects: (port: number) => Promise<readonly string[]>;
    daemonPresent: (port: number) => Promise<boolean>;
    pickPort: (preferred: number) => Promise<number>;
    /** The daemon on `port` was started from this project's directory or one above it. */
    daemonStartedHere?: (port: number) => boolean;
  },
  /** The project's directory: the port's seed when the project has no id yet. */
  dir?: string,
): Promise<number | undefined> {
  if (explicit !== undefined) return explicit;
  if (configured !== undefined) return configured;
  // Undefined, not the default's number: an explicit default would be written into every generated
  // config as a `port` nobody chose.
  if (!(await deps.daemonPresent(RETICLE_DEFAULT_PORT))) return undefined;
  // Started here — by this project's own editor MCP, typically — so it is ours whatever project id
  // it recorded. Moving off it strands that agent: an MCP resolves its port once, at startup.
  if (true === deps.daemonStartedHere?.(RETICLE_DEFAULT_PORT)) return undefined;
  // The bridge's own rule: it refuses a page only when it has served exactly ONE other project. A
  // daemon serving nobody, several projects, or ours accepts this one. A project that has never
  // been through init has no id yet, so a single named holder is somebody else.
  const holders = await deps.daemonProjects(RETICLE_DEFAULT_PORT);
  if (1 !== holders.length || holders[0] === projectId) return undefined;
  const seed = projectId ?? dir;
  return deps.pickPort(seed === undefined ? PROJECT_PORT_FIRST : projectPortFor(seed));
}

/** Is `dir` the same directory as `cwd`, or an ancestor of it? */
export function isSameOrAbove(dir: string, cwd: string): boolean {
  const rel = relative(dir, cwd);
  return '' === rel || (!rel.startsWith('..') && !isAbsolute(rel));
}
