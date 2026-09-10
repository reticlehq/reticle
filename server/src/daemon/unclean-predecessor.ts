/**
 * The pid of a daemon that died without exiting, observed at the next start.
 *
 * `DaemonExitReason` covers every departure that goes through Node — signal, idle, and the
 * load-bearing `unknown` for a stray exit or an uncaught throw. It cannot cover SIGKILL, an OOM
 * kill, or a lost machine: no handler runs, so the log's last word about that daemon is whatever it
 * happened to be doing. From the report (#123):
 *
 *   10:49:05  mcp_daemon_started        port:4400            <- pid 2884
 *   10:51:29  mcp_daemon_started        port:4400  pid:4900  <- a SECOND daemon binds the SAME port
 *
 * pid 2884 died with no exit event at all, and the only evidence was that a second daemon could bind
 * a port the first one held — something a reader has to notice and interpret.
 *
 * The next startup is the only place that death is observable, because it is the only moment
 * anything looks at the pidfile the dead process left behind. A tidy shutdown unlinks its own, so
 * finding one whose owner is gone IS the signal.
 *
 * Pure, and deliberately conservative: an owner that is still ALIVE is a port conflict, not a death,
 * and accusing a live sibling of dying would be a new false claim in the log this exists to make
 * honest.
 */
export function uncleanPredecessor(
  owner: number | null,
  alive: boolean,
  self: number,
): number | null {
  if (null === owner || owner === self || alive) return null;
  return owner;
}
