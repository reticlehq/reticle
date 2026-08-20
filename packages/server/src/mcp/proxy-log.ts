/**
 * The MCP proxy's own log file: where it lives, what bounds it, and how it is written.
 *
 * Split out of mcp-proxy.ts, which is the transport. This is housekeeping for a file, and the two
 * share nothing but a port number — the proxy calls `proxyLog`, and everything else here exists to
 * keep that file from becoming the largest thing on the user's disk.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { log } from '../log.js';
import { MAX_DAEMON_LOG_BYTES, rotateDaemonLog } from '../daemon/daemon.js';

/**
 * Which port this proxy serves, for the log file name. Set once at startup.
 *
 * One file per port, matching `daemon-<port>.log`. A single shared file interleaved every proxy on
 * the machine into one stream, so the first question anyone asks of it — "what happened to MY
 * session?" — needed a filter before it could be answered.
 */
let logPort: number | undefined;

/**
 * How much the proxy may append between size checks.
 *
 * Statting the file on every line would be a syscall per log line on a process that logs from a
 * reconnect loop. Counting what we wrote costs nothing and is exact enough, because this process is
 * the only writer of its own log. Well under the cap, so the cap is a cap rather than a suggestion.
 */
export const PROXY_LOG_CHECK_BYTES = 256 * 1024;

/** Appended since the last real size check. Reset by every check, whatever the check decides. */
let bytesSinceProxyLogCheck = 0;

/**
 * Keep the proxy log under the same cap as the daemon log, without a stat per write.
 *
 * Returns the new "bytes since the last check" counter, so the accounting is testable without a
 * filesystem. Rotation itself is `rotateDaemonLog` — the proxy log had no cap at all while the
 * daemon log on the SAME machine stayed small, which is the whole of this defect.
 */
export function accountProxyLogWrite(
  bytesSinceCheck: number,
  written: number,
  path: string,
  deps: { fileSize(p: string): number; renameFile(from: string, to: string): void },
): number {
  const total = bytesSinceCheck + written;
  if (PROXY_LOG_CHECK_BYTES > total) return total;
  rotateDaemonLog(path, deps);
  return 0;
}

/**
 * Reclaim a proxy log that a previous process already let run away. Returns the bytes reclaimed.
 *
 * Reported from the field: one machine's `proxy-4400.log` reached a third of a 460GB disk and broke
 * builds, Docker and ordinary shell commands with ENOSPC. Nothing in Reticle degraded first, so the
 * failure surfaced as the operating system refusing to write files. Files like that exist on real
 * machines now, and the cap alone does not help them: the user should not have to find one with `du`.
 *
 * TRUNCATED IN PLACE, never renamed or unlinked. A rename moves the bytes without reclaiming a byte,
 * and a file that a running process still holds open keeps its blocks allocated after an unlink
 * until that handle closes — which is why the reporter recovered with `: > ~/.reticle/proxy-4400.log`
 * and why that is the operation to copy here.
 *
 * Best-effort, in the same spirit as `rotateDaemonLog`: refusing to start the MCP server over
 * housekeeping is strictly worse than a large file.
 */
export function recoverOversizedProxyLog(
  path: string,
  deps: { fileSize(p: string): number; truncateFile(p: string): void },
  max: number = MAX_DAEMON_LOG_BYTES,
): number {
  try {
    const size = deps.fileSize(path);
    if (max >= size) return 0;
    deps.truncateFile(path);
    return size;
  } catch {
    return 0;
  }
}

/** The real filesystem behind the two rotation helpers. */
const proxyLogFileOps = {
  fileSize: (p: string): number => statSync(p).size,
  renameFile: (from: string, to: string): void => renameSync(from, to),
  truncateFile: (p: string): void => truncateSync(p, 0),
};

/** Name the proxy log after the port it serves. Called before anything can log. */
export function setProxyLogPort(port: number): void {
  logPort = port;
  // The one moment we know a size check is worth its syscall, and the only place a file inherited
  // from an older build can be brought back under control.
  const reclaimed = recoverOversizedProxyLog(proxyLogPath(port), proxyLogFileOps);
  if (0 < reclaimed) {
    proxyLog('reticle_mcp_proxy_log_truncated', {
      port,
      reclaimedBytes: reclaimed,
      note: 'the proxy log had grown past its cap and was truncated in place to reclaim the space',
    });
  }
}

/** The proxy's own log file, so a silent drop leaves a readable trace the agent can go read. */
export function proxyLogPath(port: number | undefined = logPort): string {
  const name = port === undefined ? 'mcp-proxy.log' : `proxy-${String(port)}.log`;
  return join(homedir(), ReticleDir.ROOT, name);
}

/**
 * Log to stderr (which the agent host usually swallows) AND to ~/.reticle/proxy-<port>.log, which it
 * does not. A dropped MCP connection is invisible from the agent's side — no message, no exit code —
 * so the one thing that makes it diagnosable at all is a file somebody can read afterwards.
 *
 * EXPORTED because the crash handlers need it. `installProxyResilience` was wired to the bare stderr
 * logger, so the proxy's own uncaught exceptions and unhandled rejections — the exact events that
 * present to a human as "the MCP server disconnected" — were written to a stream the editor throws
 * away. The handler ran, the process kept serving, and the reason went nowhere. Reported as "the
 * proxy has no log file… when it dies the diagnostic dies with it", which was half right: the file
 * existed, and the one path that most needed it was not using it.
 */
export function proxyLog(event: string, fields: Record<string, unknown> = {}): void {
  log(event, fields);
  try {
    const dir = join(homedir(), ReticleDir.ROOT);
    mkdirSync(dir, { recursive: true });
    // WITH A TIMESTAMP. This file is the only record of an outage that survives the session, and
    // without one it cannot answer the two questions anyone brings to it: when did this happen, and
    // how often. A real 3,283-line log on a dev machine held a `gave_up` — the exact event that used
    // to precede `process.exit(1)` and cost the human a manual /mcp reconnect — and it was
    // impossible to tell whether it happened during that person's work or a test run hours earlier.
    // Evidence you cannot place in time is an anecdote.
    const path = proxyLogPath();
    const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`;
    appendFileSync(path, line, 'utf8');
    // A single proxy process is long-lived and logs from a reconnect loop, so rotating only at
    // startup would leave the growth this file is capable of entirely unchecked while it runs.
    bytesSinceProxyLogCheck = accountProxyLogWrite(
      bytesSinceProxyLogCheck,
      Buffer.byteLength(line, 'utf8'),
      path,
      proxyLogFileOps,
    );
  } catch {
    // Logging must never be the thing that kills the proxy.
  }
}
