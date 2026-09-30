/**
 * What `init` leaves in the state home about a dev server it handed over: the log, its one rotated
 * predecessor, and a record of where the server is.
 *
 * All keyed on the app directory, beside the daemon logs and so outside the project: no bundler
 * watcher ever sees them change (a `.reticle/` write inside the app once put Vite into a continuous
 * full-reload loop), and two projects never share a file.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROTATED_SUFFIX } from './dev-server-log-cap.js';

const DEV_SERVER_PREFIX = 'dev-server-';
const LOG_SUFFIX = '.log';
const RECORD_SUFFIX = '.json';
/**
 * A log with no record is from a build before records existed, so there is no pid to ask. Anything
 * this old is from a server long gone; a live one that went this quiet loses a file it was not using.
 */
const UNRECORDED_LOG_MAX_AGE_MS = 24 * 60 * 60_000;

const OWN_FILE = /^dev-server-([0-9a-f]{12})\.(?:log|log\.1|json)$/;

function keyOf(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

export function devServerLogName(cwd: string): string {
  return `${DEV_SERVER_PREFIX}${keyOf(cwd)}${LOG_SUFFIX}`;
}

function recordName(cwd: string): string {
  return `${DEV_SERVER_PREFIX}${keyOf(cwd)}${RECORD_SUFFIX}`;
}

/** Where a handed-over server is: enough to find it again and to prove it is still that server. */
const HandedOverSchema = z.object({
  pid: z.number().int().positive(),
  url: z.string().min(1),
  appDir: z.string().min(1),
});
export type HandedOver = z.infer<typeof HandedOverSchema>;

/**
 * Written when `init` leaves a server running, so the next `init` can attach to it.
 *
 * Only Vite announces itself (through its plugin). Re-running init while a Next or Angular server
 * it had started was still up spawned a second `dev`, which failed with "port 3000 is already in use
 * — something else is serving there" — the something being the server init itself had left.
 */
export function recordHandOver(dir: string, record: HandedOver): void {
  try {
    writeFileSync(join(dir, recordName(record.appDir)), JSON.stringify(record));
  } catch {
    // Without the record the next run starts a server as it always did. Never fail a handover on it.
  }
}

function readRecord(path: string): HandedOver | undefined {
  try {
    const parsed = HandedOverSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The url of the server `init` handed over for `appDir`, when that process is alive AND the url
 * still answers — both, because a recycled pid proves nothing and a url answering proves only that
 * SOMETHING is there. Undefined otherwise, and the caller starts one.
 */
export async function handedOverUrl(
  dir: string,
  appDir: string,
  deps: { alive: (pid: number) => boolean; answers: (url: string) => Promise<boolean> },
): Promise<string | undefined> {
  const record = readRecord(join(dir, recordName(appDir)));
  if (undefined === record || record.appDir !== appDir || !deps.alive(record.pid)) return undefined;
  return (await deps.answers(record.url)) ? record.url : undefined;
}

/**
 * Stop the server `init` handed over for `appDir`, and forget it. True when one was stopped.
 *
 * For a port move: Next reads the daemon url into `NEXT_PUBLIC_RETICLE_URL` once, when `next dev`
 * starts, so attaching to the running server after `init --port <new>` left the page dialling the
 * old port — which the same run had just stopped. Only a server this record proves init started is
 * touched; one the user started is theirs to restart.
 */
export function stopHandedOver(
  dir: string,
  appDir: string,
  deps: { alive: (pid: number) => boolean; kill: (pid: number) => void },
): boolean {
  const path = join(dir, recordName(appDir));
  const record = readRecord(path);
  if (undefined === record || record.appDir !== appDir || !deps.alive(record.pid)) return false;
  deps.kill(record.pid);
  rmSync(path, { force: true });
  return true;
}

/**
 * Remove what servers that are gone left behind: their logs, rotated logs and records.
 *
 * Every run wrote a log per project and nothing ever deleted one, so the state home kept a file for
 * every app `init` had ever started. A record whose pid is dead takes its logs with it; a log with no
 * record at all goes once it is old. `keep` is the app about to start, whose files are replaced
 * anyway.
 */
export function sweepDeadDevServers(
  dir: string,
  deps: { alive: (pid: number) => boolean; now: number; keep?: string },
): void {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const keepKey = undefined === deps.keep ? undefined : keyOf(deps.keep);
  // Exactly the names this module writes, so nothing else in the state home can match.
  const keys = new Set(
    files.map((f) => OWN_FILE.exec(f)?.[1]).filter((k): k is string => undefined !== k),
  );
  for (const key of keys) {
    if (key === keepKey) continue;
    const log = join(dir, `${DEV_SERVER_PREFIX}${key}${LOG_SUFFIX}`);
    const recordPath = join(dir, `${DEV_SERVER_PREFIX}${key}${RECORD_SUFFIX}`);
    const record = readRecord(recordPath);
    const dead =
      undefined === record
        ? deps.now - lastWrittenAt(log) > UNRECORDED_LOG_MAX_AGE_MS
        : !deps.alive(record.pid);
    if (!dead) continue;
    for (const path of [log, `${log}${ROTATED_SUFFIX}`, recordPath]) rmSync(path, { force: true });
  }
}

function lastWrittenAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
