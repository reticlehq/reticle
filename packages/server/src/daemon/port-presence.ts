/**
 * What is actually on the bridge port — three states, because two produced a lie.
 *
 * `isRunning` reads the pid file and never the port. So "a stranger holds 4400" and "nothing holds
 * 4400" both answer `running: false`, and every surface built on it inherits that:
 *
 *   $ reticle serve
 *   {"event":"reticle_daemon_spawned","port":4400}        <- exit 0
 *   $ reticle status
 *   {"event":"reticle_status","port":4400,"running":false}
 *   $ tail -1 ~/.reticle/daemon-4400.log
 *   {"event":"reticle_daemon_start_failed","error":"listen EADDRINUSE: ... 127.0.0.1:4400"}
 *
 * The daemon knew exactly what was wrong and wrote it where nobody looks. The true sentence — *port
 * 4400 is held by another process* — was never said by anything a person sees.
 *
 * Deliberately probe-based rather than lsof-based: two questions (does TCP connect, does `/status`
 * answer) separate all three states with no platform-specific code, and they work on Windows, where
 * every `lsof` recipe in this repo does not. Naming the holding process is a nicer message and a
 * strictly harder problem; it is not needed to stop lying.
 */

export const PortPresence = {
  /** A Reticle daemon answered `/status`. The only usable state. */
  DAEMON: 'daemon',
  /**
   * Something accepts connections here and does not serve Reticle's status endpoint.
   *
   * A foreign process, or one of our own daemons wedged mid-start — and those are the same fact for
   * every caller: this port cannot be bound and cannot be used.
   */
  FOREIGN: 'foreign',
  /** Nothing is listening. */
  FREE: 'free',
} as const;
export type PortPresence = (typeof PortPresence)[keyof typeof PortPresence];

interface PortFacts {
  /** A TCP connection to the port was accepted. */
  tcpOpen: boolean;
  /** An HTTP GET of `/status` returned a Reticle status payload. */
  statusAnswered: boolean;
}

/**
 * Pure. The probes live at the call sites (`probeDaemon`, `fetchStatus`) so this stays testable
 * without a socket, and so a probe that starts lying is a separate failure from a rule that does.
 */
export function classifyPort(facts: PortFacts): PortPresence {
  if (facts.statusAnswered) {
    if (!facts.tcpOpen) {
      // Not reachable from a real pair of probes. Folding it into DAEMON would mean a broken TCP
      // probe reports a healthy daemon — the exact shape of confident-wrong this module exists to
      // remove — so it is an error rather than a guess.
      throw new Error(
        'a port cannot answer /status without accepting a TCP connection; one of the probes is wrong',
      );
    }
    return PortPresence.DAEMON;
  }
  return facts.tcpOpen ? PortPresence.FOREIGN : PortPresence.FREE;
}

/** True only for a daemon that answered. Anything else must not be treated as "running". */
export function presenceIsUsable(presence: PortPresence): boolean {
  return presence === PortPresence.DAEMON;
}

/**
 * Ask the port both questions and classify the answers.
 *
 * The TCP probe is first and cheap; `/status` is only asked when something accepted, which keeps the
 * common "nothing there" case to one failed connect. Impure by necessity — the rule above is where
 * the behaviour lives, and it is tested without a socket.
 */
export async function probePresence(
  port: number,
  probes: {
    tcpOpen: (port: number) => Promise<boolean>;
    status: (port: number) => Promise<unknown>;
  },
): Promise<PortPresence> {
  const tcpOpen = await probes.tcpOpen(port);
  if (!tcpOpen) return PortPresence.FREE;
  const status = await probes.status(port);
  return classifyPort({ tcpOpen, statusAnswered: status !== undefined });
}

/**
 * Who is holding the port, when we can tell.
 *
 * `FOREIGN` covers two situations that need the same answer to "can I bind this?" and OPPOSITE
 * answers to "what do I do?": a stranger's process, and one of our own daemons wedged. Passing
 * these lets the sentence tell them apart when — and only when — the recorded pid for the port
 * matches the process actually holding it.
 */
export interface PortHolder {
  /** The pid we recorded for this port, from the daemon pid file. `null` when there is none. */
  ourPid: number | null;
  /** The pid actually holding the port, when the caller could determine it. */
  holderPid: number | undefined;
}

/** One sentence a human can act on, for each state. Exhaustive by switch, so a new state must add one. */
export function describePresence(
  presence: PortPresence,
  port: number,
  holder?: PortHolder,
): string {
  switch (presence) {
    case PortPresence.DAEMON:
      return `a Reticle daemon is serving :${String(port)}`;
    case PortPresence.FOREIGN:
      // Our own daemon, wedged: it accepts TCP and never answers `/status`, so it classifies as
      // FOREIGN — correct for binding, and a lie in prose. Found by SIGSTOPping a daemon: doctor
      // said "which is not a Reticle daemon" about a pid its own pid file named, and sent the
      // reader hunting a stranger while never mentioning the fix that works.
      if (
        holder?.ourPid !== null &&
        holder?.ourPid !== undefined &&
        holder.ourPid === holder.holderPid
      ) {
        return (
          `port ${String(port)} is held by YOUR Reticle daemon (pid ${String(holder.ourPid)}), ` +
          'and it is not responding — it is running but wedged, so nothing can use it and nothing ' +
          'else can bind the port. Stop it (`reticle stop`) and the next tool call starts a fresh ' +
          'one.'
        );
      }
      return (
        `port ${String(port)} is held by another process that is not a Reticle daemon — ` +
        'a daemon cannot bind it. Stop that process, or run Reticle on a different port ' +
        '(`--port`), then retry.'
      );
    case PortPresence.FREE:
      return `nothing is listening on :${String(port)} — no daemon is running`;
  }
}
