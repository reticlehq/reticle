/**
 * Process-level resilience for the long-running daemon. The daemon serves many agents at once, so a
 * single stray error must not take the whole fleet down:
 *
 *  - unhandledRejection (a fire-and-forget promise nobody awaited — the common case in async WS/pool
 *    code) → LOG and keep running. One agent's async slip-up can't crash the daemon for everyone.
 *  - uncaughtException (a synchronous throw escaped all try/catch) → the process state is undefined
 *    per Node's guidance, so LOG a clear reason and exit cleanly; the next `reticle mcp` respawns a fresh
 *    daemon, which beats crashing silently or limping along corrupt.
 */

export interface ProcessLike {
  on(event: string, listener: (arg: unknown) => void): unknown;
}

type LogFn = (event: string, data: Record<string, unknown>) => void;

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function installDaemonResilience(proc: ProcessLike, log: LogFn, onFatal: () => void): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    log('reticle_daemon_unhandled_rejection', { reason: describe(reason) });
  });
  proc.on('uncaughtException', (err: unknown) => {
    log('reticle_daemon_uncaught_exception', { error: describe(err) });
    onFatal();
  });
}
