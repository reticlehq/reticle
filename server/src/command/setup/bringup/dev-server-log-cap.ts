/**
 * The dev server's log, with a ceiling — and the small process that enforces it.
 *
 * The handed-over dev server wrote straight into a file descriptor, which is what keeps it alive once
 * `init` exits (a pipe whose reader has gone is an EPIPE on the next write). But a descriptor nobody
 * reads has no ceiling: an upstream echo loop — TanStack devtools and Vite 8 forwarding each other's
 * console lines — grew `~/.reticle/dev-server-<hash>.log` to 2.9 GB in about five minutes.
 *
 * So the server's output goes through a pipe again, and the reader on the other end is THIS script,
 * run as its own process in the server's process group rather than inside `init`. It lives exactly
 * as long as the server's output does: it exits when the pipes close, never before, so the EPIPE
 * that killed handed-over servers cannot come back. It ignores the signals a group stop sends, for
 * the same reason — the server gets them too, and may still be writing on its way out.
 *
 * The bound is rotation, not truncation: past the cap the file is renamed to `<log>.1` (replacing
 * the previous one) and a fresh file started, so disk use stays under twice the cap while the most
 * recent output — the part anybody reads — is always there.
 *
 * Why not truncate from the daemon on a timer: the daemon idles out on its own schedule and a
 * handed-over server does not, so the one bound that matters would stop being enforced exactly when
 * nobody is watching. A reader that shares the server's lifetime cannot be outlived by it.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync, renameSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Per file. The log and its one rotated predecessor together never exceed twice this. */
export const DEV_SERVER_LOG_CAP_BYTES = 8 * 1024 * 1024;
/** The single predecessor a rotation keeps. */
export const ROTATED_SUFFIX = '.1';

/** Appends to `path`, rotating it to `path.1` whenever the next write would pass `capBytes`. */
export class BoundedLog {
  #fd: number;
  #size = 0;

  constructor(
    private readonly path: string,
    private readonly capBytes: number = DEV_SERVER_LOG_CAP_BYTES,
  ) {
    this.#fd = openSync(path, 'a');
  }

  write(chunk: Buffer): void {
    try {
      if (0 < this.#size && this.#size + chunk.length > this.capBytes) this.#rotate();
      // A single chunk bigger than the cap is kept only in its tail: it is still bounded.
      const kept =
        chunk.length > this.capBytes ? chunk.subarray(chunk.length - this.capBytes) : chunk;
      writeSync(this.#fd, kept);
      this.#size += kept.length;
    } catch {
      // Disk full, a removed state dir: the output is lost, the server is not. Never throw here.
    }
  }

  close(): void {
    try {
      closeSync(this.#fd);
    } catch {
      /* already closed */
    }
  }

  #rotate(): void {
    closeSync(this.#fd);
    renameSync(this.path, `${this.path}${ROTATED_SUFFIX}`);
    this.#fd = openSync(this.path, 'a');
    this.#size = 0;
  }
}

/** Arguments are `<log path> <cap bytes> <shell command>`, the way `OwnedDevServer` spawns this. */
function main(argv: readonly string[]): void {
  const [logPath, cap, command] = argv;
  if (undefined === logPath || undefined === command) process.exit(2);
  const log = new BoundedLog(logPath, Number(cap) || DEV_SERVER_LOG_CAP_BYTES);
  // Stopping the group signals both of us. The server decides when it is done; this outlives it.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => {});
  const child = spawn(command, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', (chunk: Buffer) => log.write(chunk));
  child.stderr.on('data', (chunk: Buffer) => log.write(chunk));
  // `close`, not `exit`: every byte the server wrote is read before this process goes.
  child.on('close', (code) => {
    log.close();
    process.exit(code ?? 1);
  });
  child.on('error', () => {
    log.close();
    process.exit(1);
  });
}

const entry = process.argv[1];
if (undefined !== entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2));
}
