/**
 * Wait for the battery's ports to be free, on every platform.
 *
 * This was a `lsof` loop in `run-ci.sh`, and `lsof` does not exist on Windows. The shape it was
 * written in made that silent rather than loud:
 *
 *   lsof -nP -iTCP:"$port" -sTCP:LISTEN -t > /dev/null 2>&1 || break
 *
 * A missing command exits non-zero, so `|| break` fired on the FIRST iteration and the guard
 * concluded the port was free — for a tool that had never run. The `if` below it failed the same
 * way, so the refusal never fired either. The result is the exact failure the guard exists to
 * prevent, with none of the message it exists to print: the battery boots onto an occupied port and
 * dies on a raw `EADDRINUSE` stack, or worse, runs against ANOTHER process's app and reports on it.
 *
 * `gate-harness.mjs` already carries this lesson for its own callers — "Windows has no lsof, and
 * `lsof()` answers 'nothing matched' for a tool that is absent, an honest answer to the wrong
 * question" — and `port-pid.mjs` is the netstat-backed equivalent it reaches for. This is that same
 * answer, given to `run-ci.sh`, which never got it.
 *
 * Usage: node apps/e2e/await-free-ports.mjs 8787 4310 3100 14400
 * Exits 0 when every port is free, 1 with the holder named when one is still held.
 */
import { pidOnPort } from './port-pid.mjs';

/** Matches the shell loop this replaces: up to 30 one-second polls per port. */
const ATTEMPTS = 30;
const INTERVAL_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ports = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (ports.length === 0) {
  console.error('await-free-ports: no ports given');
  process.exit(1);
}

for (const port of ports) {
  let holder = pidOnPort(port);
  for (let attempt = 0; attempt < ATTEMPTS && holder !== null; attempt += 1) {
    await sleep(INTERVAL_MS);
    holder = pidOnPort(port);
  }
  if (holder !== null) {
    // Name the holder. The old message promised this and, on Windows, printed nothing at all.
    console.error(`port ${String(port)} is still held after 30s by pid ${holder}.`);
    console.error("the battery would run against another process's app — refusing to start.");
    process.exit(1);
  }
}
