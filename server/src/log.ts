/**
 * Structured logging to stderr. stdout is reserved for the MCP stdio transport — never
 * write logs there.
 *
 * Every line carries `t`, an ISO-8601 wall clock, FIRST.
 *
 * It did not, and that cost a real investigation its conclusion: `~/.reticle/daemon-4400.log` had
 * grown to 24MB of events and not one of them could be placed in time, so "the daemon vanished right
 * behind the proxy" could only ever be "points at" and never "is". Ordering the key first also means
 * a huge log can be bisected by eye, and by `sort`, without parsing it.
 *
 * The clock is read here rather than injected: this is the I/O boundary, not pure logic, and a
 * logger that needs its caller to supply the time is a logger callers will route around.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields });
  process.stderr.write(`${line}\n`);
}
