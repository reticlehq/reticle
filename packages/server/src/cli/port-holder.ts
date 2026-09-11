/**
 * Who is holding the bridge port.
 *
 * `doctor` is what a user runs when the agent cannot reach the bridge, and the commonest real cause
 * is that something else is on 4400. It already stopped saying "nothing is listening" for that case,
 * but it did not say WHICH process — so the reader's next move was a shell command they had to know.
 *
 * Naming the holder is also the safe answer to a trap this project has hit for real: the obvious
 * lookup, `lsof -ti tcp:4400 | xargs kill -9`, ALSO kills the agent's own `reticle mcp` proxy,
 * because that proxy holds a client connection to the same port and `-ti` does not filter to
 * listeners. Every invocation here is `-sTCP:LISTEN`, and the message never suggests `-ti`.
 *
 * The parser is pure and the lookup takes an injected exec, so the rule is tested on every platform
 * while the shelling out stays at the call site.
 */

import { spawnSync } from 'node:child_process';

export interface PortHolder {
  pid: number;
  command: string;
}

/** Bound on the holder lookup. A hung `lsof` must not hang the commands that diagnose hangs. */
const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Run a lookup and return its stdout, or null if it could not run.
 *
 * Null on ANY failure — no lsof (every Windows user, a slim container), a non-zero exit, a throw.
 * This is a diagnostic nicety inside the commands people run when things are already broken; it must
 * never be the reason one of them fails. Every caller handles the null by saying it could not
 * identify the holder, rather than asserting the holder is not ours — a claim it has no evidence
 * for, and one that was wrong for every Windows user.
 */
export function captureLookup(command: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS });
    return 0 === result.status && 'string' === typeof result.stdout ? result.stdout : null;
  } catch {
    return null;
  }
}

/** `lsof -F pc` emits one field per line, prefixed by its selector: `p<pid>`, `c<command>`. */
const PID_FIELD = 'p';
const COMMAND_FIELD = 'c';

/**
 * The FIRST listener in `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pc` output, or null.
 *
 * First, not "the only one": a dual-stack listener (IPv4 + IPv6) is reported twice, and on a port
 * conflict the answer the reader needs is "something is there, here is what" rather than an
 * exhaustive list. A second `p` record ends the first.
 *
 * Null on anything incomplete. Half an answer — a pid with no command — prints worse than the
 * un-named message it would replace, which is the same mistake as the port lie this command fixed.
 */
export function parsePortHolder(stdout: string): PortHolder | null {
  let pid: number | undefined;
  let command: string | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (0 === line.length) continue;
    const value = line.slice(1);
    if (line.startsWith(PID_FIELD)) {
      if (pid !== undefined) break; // a second record: the first one is the answer
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      pid = parsed;
      continue;
    }
    if (line.startsWith(COMMAND_FIELD) && command === undefined) command = value;
  }
  return pid === undefined || command === undefined ? null : { pid, command };
}

/** What `doctor` prints for a port held by something that is not a Reticle daemon. */
export function describeForeignHolder(
  port: number,
  holder: PortHolder | null,
  /**
   * The pid we recorded for this port, from the daemon pid file.
   *
   * When it matches the process actually holding the port, the port is held by OUR daemon — one
   * that accepts TCP and never answers `/status`, i.e. wedged. That classifies as FOREIGN, which is
   * right for "can anything bind this?" and wrong to say out loud: the reader goes hunting a
   * stranger, and the fix that works (`reticle stop`, it respawns on the next call) is never named.
   */
  ourPid?: number | null,
): string {
  // Naming the command matters more than naming the process. "Stop that process" describes an
  // outcome and leaves the reader to invent a route to it, and the route they invent is the `-ti`
  // pipeline that takes their agent's proxy down with the holder.
  const tail =
    'a daemon cannot bind it. Free it with `reticle kill --force` (it signals the listener only, ' +
    "never the agent's mcp proxy), or run Reticle on a different port (`--port`), then retry.";
  if (null === holder) {
    /**
     * We could not identify the holder — no `lsof` (every Windows user, and 35% of them by the
     * 2026-08 telemetry; also a slim container), or the lookup timed out.
     *
     * This used to assert the port was held by "another process that is not a Reticle daemon",
     * which is a claim the null case has NO evidence for. It is also the likeliest thing to be
     * wrong: reaching here at all means presence is FOREIGN — the port accepts TCP and never
     * answers `/status` — and the commonest cause of that is OUR OWN daemon, wedged. So on the one
     * platform where the lookup cannot run, `doctor` sent the reader hunting a stranger and never
     * named `reticle stop`, the fix that actually works.
     *
     * Say what is known, and name the recorded pid when there is one.
     */
    const ours =
      ourPid !== null && ourPid !== undefined
        ? ` Reticle's own records show pid ${String(ourPid)} for this port — if that process is ` +
          'still around it is a wedged Reticle daemon, and `reticle stop` clears it.'
        : '';
    return `port ${String(port)} is held by a process Reticle could not identify — ${tail}${ours}`;
  }
  if (ourPid !== null && ourPid !== undefined && ourPid === holder.pid) {
    return (
      `port ${String(port)} is held by YOUR Reticle daemon (pid ${String(holder.pid)}), and it is ` +
      'not responding — running but wedged, so nothing can use it and nothing else can bind the ' +
      'port. Stop it with `reticle stop`; the next tool call starts a fresh one.'
    );
  }
  return (
    `port ${String(port)} is held by pid ${String(holder.pid)} ("${holder.command}"), which is not ` +
    `a Reticle daemon — ${tail}`
  );
}

/** The lookup itself. `exec` is injected so the shelling out never runs in a unit test. */
export function findPortHolder(
  port: number,
  exec: (command: string, args: readonly string[]) => string | null,
): PortHolder | null {
  // -n/-P skip DNS and service-name lookups (slow, and irrelevant here). -sTCP:LISTEN is the part
  // that matters: without it this also reports the agent's own MCP proxy, which is a client of the
  // port, not its owner.
  const out = exec('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-F', 'pc']);
  return null === out ? null : parsePortHolder(out);
}
