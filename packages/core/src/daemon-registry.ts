import { z } from 'zod';

/**
 * The daemon discovery registry: each live daemon drops a `daemon-<port>.json` in ~/.reticle so a
 * build-time tool (vite/next plugin) can find the RIGHT daemon by projectId instead of forcing the
 * user to reconcile a port in two places (the app's SDK and the daemon's RETICLE_PORT). This is the
 * contract shared by the writer (the daemon) and the reader (the build plugins) — filename + shape +
 * the pure selection rule live here so they can never drift.
 */

const DAEMON_REGISTRY_PREFIX = 'daemon-';
const DAEMON_REGISTRY_SUFFIX = '.json';

/** The registry filename for a daemon on `port` (sibling of daemon-<port>.pid / .log). */
export function daemonRegistryFileName(port: number): string {
  return `${DAEMON_REGISTRY_PREFIX}${String(port)}${DAEMON_REGISTRY_SUFFIX}`;
}

/** Extract the port from a registry filename, or null when the name isn't a registry entry. */
export function daemonRegistryPort(fileName: string): number | null {
  if (!fileName.startsWith(DAEMON_REGISTRY_PREFIX) || !fileName.endsWith(DAEMON_REGISTRY_SUFFIX)) {
    return null;
  }
  const mid = fileName.slice(DAEMON_REGISTRY_PREFIX.length, -DAEMON_REGISTRY_SUFFIX.length);
  return /^\d+$/.test(mid) ? Number(mid) : null;
}

/** One daemon's registry entry: enough to match it to a project and prove it's still alive. */
export const DaemonRegistryEntrySchema = z.object({
  port: z.number(),
  pid: z.number(),
  cwd: z.string(),
  projectId: z.string().optional(),
  startedAt: z.number(),
});
export type DaemonRegistryEntry = z.infer<typeof DaemonRegistryEntrySchema>;

/**
 * Pick the daemon port an app should connect to, given the registry entries, the app's projectId, and
 * a liveness probe. Pure so both the vite and next plugins share one rule and it's unit-testable:
 *   1. drop dead daemons (crashed, stale entry);
 *   2. among the living, prefer the one whose projectId matches the app's — lowest port wins on a tie;
 *   3. return null when nothing matches, so the caller falls back to the default port (never guesses a
 *      mismatched daemon — a wrong auto-connect is worse than the honest default).
 */
export function pickDaemonPort(
  entries: readonly DaemonRegistryEntry[],
  projectId: string | undefined,
  isAlive: (pid: number) => boolean,
): number | null {
  if (projectId === undefined || projectId.length === 0) return null;
  const matches = entries
    .filter((e) => e.projectId === projectId && isAlive(e.pid))
    .map((e) => e.port)
    .sort((a, b) => a - b);
  return matches[0] ?? null;
}
