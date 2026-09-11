/**
 * Whether this daemon has ever been useful to anyone.
 *
 * Reticle is usually registered as a GLOBAL MCP server, so every agent session in every directory
 * spawns it — including the three quarters of directories that are not web apps at all. Measured
 * over a day: `stack` was null for 92 of 121 profiled projects, 50 were not even git repositories,
 * and 74% of daemon sessions never called a single tool. Median daemon lifetime 28 minutes; total
 * uptime across those sessions 10,816 minutes against 4.6 minutes of actual work — a duty cycle of
 * **0.04%**.
 *
 * The existing idle-shutdown could never fire on any of it, because its predicate is
 * `!agentConnected && …` and an attached agent keeps `agentConnected` true for the whole editor
 * session. So a daemon sat for half an hour, in a directory with no app, doing nothing, holding
 * memory and a port.
 *
 * The rule here is deliberately the most conservative one that still catches that population:
 * a daemon is USELESS only if it has never served a tool call AND no browser has ever connected to
 * it AND nothing is leased from the pool. All three are lifetime facts, not windows — so nothing
 * transient trips it, and a daemon in this state provably holds no recording, baseline or session
 * anybody could lose. When it does shut down, the MCP proxy reconnects and `ensureDaemon` spawns a
 * fresh one on the next call, which is a path already exercised hundreds of times a day.
 */

/** Set the first time any tool is dispatched through runTool — the chokepoint every path shares. */
let servedToolCall = false;

export function noteToolCall(): void {
  servedToolCall = true;
}

export function everServedToolCall(): boolean {
  return servedToolCall;
}

/** Tests only. */
export function resetDaemonUsefulness(): void {
  servedToolCall = false;
}

interface UsefulnessFacts {
  /** Has any tool been dispatched since this daemon booted? */
  servedToolCall: boolean;
  /** Has any browser session ever connected? */
  everConnected: boolean;
  /** Active pool leases — a lease means somebody is mid-flight even with no session yet. */
  activeLeases: number;
}

/**
 * True when the daemon has done nothing for anyone and has nothing to lose by exiting.
 *
 * Every clause is a LIFETIME fact. "No tool call in the last five minutes" would fire on a thinking
 * pause; "no tool call ever" cannot.
 */
export function isUselessDaemon(facts: UsefulnessFacts): boolean {
  return !facts.servedToolCall && !facts.everConnected && 0 === facts.activeLeases;
}

/** The little of SessionManager the idle predicate reads — structural, so a fake needs two methods. */
interface IdleSessions {
  count(): number;
  everConnected(): boolean;
}

/** The little of BrowserPool it reads. */
interface IdlePool {
  activeCount(): number;
}

/**
 * The daemon's whole "is anything happening" question.
 *
 * Two ways to be idle. The original — nobody attached, nothing connected. And the one that was
 * missing: an agent IS attached but this daemon has never served a tool call and no browser has ever
 * connected to it. `agentConnected` stays true for an entire editor session, so without the second
 * clause the shutdown watcher could never fire on the 74% of daemons that spawn in a directory with
 * no app and sit there for half an hour.
 */
export function buildIdlePredicate(
  agentConnected: () => boolean,
  sessions: IdleSessions,
  pool: IdlePool,
): () => boolean {
  return () =>
    (!agentConnected() ||
      isUselessDaemon({
        servedToolCall: everServedToolCall(),
        everConnected: sessions.everConnected(),
        activeLeases: pool.activeCount(),
      })) &&
    0 === sessions.count() &&
    0 === pool.activeCount();
}
