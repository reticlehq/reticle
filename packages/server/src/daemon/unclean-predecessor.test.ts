import { describe, expect, it } from 'vitest';
import { uncleanPredecessor } from './unclean-predecessor.js';

/**
 * A daemon that was KILLED leaves no exit line, because no handler runs.
 *
 * `DaemonExitReason` covers every departure that goes through Node — signal, idle, and the
 * load-bearing `unknown` for a stray exit or an uncaught throw. It cannot cover SIGKILL, an OOM
 * kill, or a lost machine: the process is simply gone, and the log's last word about it is whatever
 * it happened to be doing.
 *
 * That is the first half of #123, and it is the half that read as normal:
 *
 *   10:49:05  mcp_daemon_started        port:4400            <- pid 2884
 *   10:51:29  mcp_daemon_started        port:4400  pid:4900  <- a SECOND daemon binds the SAME port
 *
 * pid 2884 died with no exit event at all, and the only evidence was that a second daemon could bind
 * a port the first one held. The next startup is the only place that death can be observed, because
 * it is the only moment anything looks at the pidfile the dead process left behind.
 *
 * Pure: the decision is separated from the filesystem, so every branch is asserted here rather than
 * inferred from a fixture that has to arrange a real orphan.
 */
describe('uncleanPredecessor', () => {
  const SELF = 4900;

  it('reports the pid when the pidfile names a DEAD process that is not us', () => {
    expect(uncleanPredecessor(2884, false, SELF)).toBe(2884);
  });

  it('is silent when the previous daemon is still alive — that is a port conflict, not a death', () => {
    // A losing child hitting EADDRINUSE must not accuse the winner of dying.
    expect(uncleanPredecessor(2884, true, SELF)).toBeNull();
  });

  it('is silent when the pidfile is ours — a restart in place is not a predecessor', () => {
    expect(uncleanPredecessor(SELF, false, SELF)).toBeNull();
  });

  it('is silent when there is no pidfile — the ordinary first start', () => {
    // The common case by far. A first start must not log a death that never happened.
    expect(uncleanPredecessor(null, false, SELF)).toBeNull();
  });

  it('is silent for a tidy shutdown, which removed its own pidfile', () => {
    // removePid() unlinks on the way out, so a clean exit reaches the next start as `null` — the
    // same shape as a first start, which is exactly why the two used to be indistinguishable.
    expect(uncleanPredecessor(null, true, SELF)).toBeNull();
  });
});
