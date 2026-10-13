/**
 * Which ports a process tree is listening on, parsed from the tools that can answer that.
 *
 * Kept separate from the commands that produce the text so the Windows behaviour is testable from
 * any machine. That is not a stylistic preference: port discovery on Windows returned nothing at
 * all until this was extracted, so a dev server that prints no parseable URL was undiscoverable
 * there — and `react-scripts` prints no parseable URL outside a tty, which makes it the majority
 * platform's most common React setup.
 */

/** One LISTENING socket and the process that owns it. */
interface Listener {
  readonly port: number;
  readonly pid: number;
}

/** `lsof -a -p <pids> -iTCP -sTCP:LISTEN -P -n`, NAME column only. */
export function parseLsofPorts(out: string): number[] {
  const ports = new Set<number>();
  for (const m of String(out).matchAll(/:(\d+)\s*$/gm)) ports.add(Number(m[1]));
  return [...ports];
}

const NETSTAT_PROTO = 'TCP';
const NETSTAT_STATE = 'LISTENING';
const NETSTAT_MIN_COLUMNS = 5;

/**
 * `netstat -ano` on Windows.
 *
 * The port is whatever follows the LAST colon: `[::]:3000` has three of them, so splitting on ':'
 * and taking index 1 reads every IPv6 row as port 0 and silently drops half the table.
 */
export function parseNetstatListeners(out: string): Listener[] {
  const rows: Listener[] = [];
  for (const line of String(out).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < NETSTAT_MIN_COLUMNS) continue;
    if (f[0]?.toUpperCase() !== NETSTAT_PROTO || f[3]?.toUpperCase() !== NETSTAT_STATE) continue;
    const local = f[1] ?? '';
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    const pid = Number(f[4]);
    if (Number.isInteger(port) && port > 0 && Number.isInteger(pid)) rows.push({ port, pid });
  }
  return rows;
}

/**
 * One (pid, parent) pair, as `wmic process get CreationDate,ParentProcessId,ProcessId` prints them.
 *
 * `startedAtMs` is the process's own creation time, when the source gave one. It is what tells a
 * real child from a stale link: Windows never clears ParentProcessId when a parent exits, and it
 * reuses pids, so "ppid matches" alone can adopt an unrelated, older process. See `descendants`.
 */
export interface ProcessPair {
  readonly pid: number;
  readonly ppid: number;
  readonly startedAtMs?: number;
}

/** A WMI datetime: `yyyymmddHHMMSS.ffffff` then the offset from UTC in minutes, `+000` / `-300`. */
const WMI_DATETIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;
const MICROS_PER_MS = 1000;
const MS_PER_MINUTE = 60_000;

/** Epoch milliseconds of a WMI datetime, or undefined when it is not one. */
export function parseWmiDatetime(text: string): number | undefined {
  const m = WMI_DATETIME.exec(text);
  if (null === m) return undefined;
  const n = (index: number): number => Number(m[index]);
  const local = Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6), Math.floor(n(7) / MICROS_PER_MS));
  const minutesEast = '-' === m[8] ? -n(9) : n(9);
  return local - minutesEast * MS_PER_MINUTE;
}

export function parseWmicProcesses(out: string): ProcessPair[] {
  const pairs: ProcessPair[] = [];
  for (const line of String(out).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    // Two columns (ppid pid), or three with the creation time first: wmic prints its columns in
    // alphabetical order, and the PowerShell fallback prints the same shape on purpose.
    const timed = 3 === f.length;
    if (!timed && 2 !== f.length) continue;
    const startedAtMs = timed ? parseWmiDatetime(f[0] ?? '') : undefined;
    if (timed && undefined === startedAtMs) continue;
    const ppid = Number(f[timed ? 1 : 0]);
    const pid = Number(f[timed ? 2 : 1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    pairs.push(undefined === startedAtMs ? { pid, ppid } : { pid, ppid, startedAtMs });
  }
  return pairs;
}

/**
 * `root` and everything descended from it.
 *
 * The dev server is almost never the process we spawned: `npm run dev` starts a shell, which starts
 * node, which binds the port. Matching only the pid we hold finds nothing, and nothing is
 * indistinguishable from "no server".
 */
export function descendants(pairs: readonly ProcessPair[], root: number): number[] {
  const startedAt = new Map<number, number>();
  for (const { pid, startedAtMs } of pairs) {
    if (undefined !== startedAtMs) startedAt.set(pid, startedAtMs);
  }
  const byParent = new Map<number, number[]>();
  for (const { pid, ppid, startedAtMs } of pairs) {
    // A child created before the parent it names is a stale link left by pid reuse, not a child.
    const parentStarted = startedAt.get(ppid);
    if (undefined !== startedAtMs && undefined !== parentStarted && startedAtMs < parentStarted) {
      continue;
    }
    const kids = byParent.get(ppid);
    if (kids === undefined) byParent.set(ppid, [pid]);
    else kids.push(pid);
  }
  const found = new Set<number>([root]);
  const queue: number[] = [root];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) continue;
    for (const child of byParent.get(next) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}
