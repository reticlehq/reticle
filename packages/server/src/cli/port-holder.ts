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

export interface PortHolder {
  pid: number;
  command: string;
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
export function describeForeignHolder(port: number, holder: PortHolder | null): string {
  const tail =
    'a daemon cannot bind it. Stop that process, or run Reticle on a different port ' +
    '(`--port`), then retry.';
  if (null === holder) {
    return `port ${String(port)} is held by another process that is not a Reticle daemon — ${tail}`;
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
