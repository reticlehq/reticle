/**
 * Which process is LISTENING on a port — on every platform CI runs.
 *
 * The specs that watch a daemon's life have to read the port, not the pid file: a pid file can be
 * stale, name a dead process, or name a live one that is not the listener, and "is the daemon up"
 * answered from it is exactly the false green those specs exist to catch.
 *
 * They did that with `lsof`, which does not exist on Windows. `execSync` throws there, the catch
 * returns null, and every "a daemon came up" assertion reads as failure — so the specs could never
 * run on the one platform whose daemon bugs shipped through a release unseen (#248). A gate that is
 * red for a tooling reason is worse than no gate: it says nothing about the product and it trains
 * people to ignore the job.
 *
 * `netstat -ano` is the Windows equivalent and is present on every Windows image. Its output is
 * columnar with the PID last:
 *
 *   TCP    127.0.0.1:4699    0.0.0.0:0    LISTENING    12345
 *
 * Matched on `:PORT` at a word boundary so :4699 never matches :46990, and on LISTENING so an
 * outbound connection to the same port is not mistaken for the server.
 */
import { execSync } from 'node:child_process';

const WINDOWS = 'win32' === process.platform;

/** The pid listening on `port`, or null. Never throws — "cannot tell" is reported as null. */
export function pidOnPort(port) {
  try {
    if (WINDOWS) {
      const out = execSync(`netstat -ano -p TCP | findstr LISTENING | findstr :${port}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      for (const line of out.split(/\r?\n/)) {
        // Local address must end at exactly this port, or :4699 matches :46990.
        if (!new RegExp(`:${port}\\b`).test(line)) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) return pid;
      }
      return null;
    }
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim().split('\n')[0] || null;
  } catch {
    // Nothing listening, or the tool is absent. Both mean "no pid to report".
    return null;
  }
}
