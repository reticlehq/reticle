/**
 * The Harness drives this daemon is running, and the ones it finished, by run id.
 *
 * A drive takes minutes and an MCP client gives a tool call about one. Awaited inside the call, a
 * drive outlived the client's timeout: the agent got no run id, the daemon kept driving and
 * spending, and a retry started a second paid drive. So a drive is started here and the call only
 * waits on it for a while; whoever asks again by run id (the same agent, another one, the HUD)
 * reads the same entry.
 *
 * No I/O and no tool surface: what to run and where to write it arrive as functions, so this stays
 * a sink the surface hands things to.
 */
import { ReticleTool, type HarnessDrive, type ImpactSnapshot } from '@reticlehq/core';

export const DriveStatus = {
  RUNNING: 'running',
  DONE: 'done',
  STOPPED: 'stopped',
  BROKEN: 'broken',
} as const;
export type DriveStatus = (typeof DriveStatus)[keyof typeof DriveStatus];

/** Who asked for the drive. */
export const DriveOrigin = { AGENT: 'agent', HUD: 'hud', CHAT: 'chat' } as const;
export type DriveOrigin = (typeof DriveOrigin)[keyof typeof DriveOrigin];

/**
 * One drive, as it is written to `.reticle/runs/<run>.drive.json` and answered to a poll.
 *
 * The id is `harnessRun`, never `runId`: the sync uploads every file in that directory carrying a
 * `runId` as a verification run, and this record would then collide with the drive's own run.
 */
export interface DriveRecord {
  harnessRun: string;
  status: DriveStatus;
  origin: DriveOrigin;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  steps: number;
  lastLine: string;
  /** The tool's full answer, once the drive has ended. */
  result?: Record<string, unknown>;
  /** Why it broke, when it threw instead of answering. */
  error?: string;
}

/** What a running drive reads from whoever started it. */
export interface DriveControl {
  /** True once somebody asked it to stop. */
  stopped: () => boolean;
  /** Text somebody said to it since it last asked, oldest first. */
  takeSaid: () => string[];
}

interface Entry {
  record: DriveRecord;
  harness: string;
  abort: AbortController;
  inbox: string[];
  waiters: Set<(record: DriveRecord) => void>;
}

/** Finished drives kept for polling; older ones are read back from disk. */
const MAX_FINISHED = 50;
const LANE_SUFFIX = /-L\d+$/;

const entries = new Map<string, Entry>();
const byHarness = new Map<string, Entry>();
/** One pending note per drive, latest state wins: what the agent has not heard yet. */
const notes = new Map<string, string>();
const changeListeners = new Set<(record: DriveRecord) => void>();

export interface StartDrive {
  harness: string;
  runId: string;
  origin: DriveOrigin;
  sessionId?: string;
  now: () => number;
  persist: (record: DriveRecord) => Promise<void>;
  run: (control: DriveControl) => Promise<{ status: DriveStatus; result: Record<string, unknown> }>;
}

export function startDrive(start: StartDrive): DriveRecord {
  const record: DriveRecord = {
    harnessRun: start.runId,
    status: DriveStatus.RUNNING,
    origin: start.origin,
    ...(start.sessionId === undefined ? {} : { sessionId: start.sessionId }),
    startedAt: start.now(),
    steps: 0,
    lastLine: 'Harness is starting',
  };
  const entry: Entry = {
    record,
    harness: start.harness,
    abort: new AbortController(),
    inbox: [],
    waiters: new Set(),
  };
  entries.set(start.runId, entry);
  byHarness.set(start.harness, entry);
  const save = (): void => {
    // A record that cannot be written is still a drive the registry answers for.
    void start.persist({ ...entry.record }).catch(() => undefined);
  };
  save();
  changed(entry, true);
  const control: DriveControl = {
    stopped: () => entry.abort.signal.aborted,
    takeSaid: () => entry.inbox.splice(0),
  };
  void start
    .run(control)
    .then(
      ({ status, result }) => {
        entry.record = { ...entry.record, status, result };
      },
      (error: unknown) => {
        entry.record = {
          ...entry.record,
          status: DriveStatus.BROKEN,
          error: error instanceof Error ? error.message : String(error),
        };
      },
    )
    .then(() => {
      entry.record.endedAt = start.now();
      save();
      changed(entry, true);
      prune();
    });
  return { ...record };
}

/** The drive this run id names, while this daemon still holds it. */
export function driveRecord(runId: string): DriveRecord | undefined {
  const entry = entries.get(runId);
  return entry === undefined ? undefined : { ...entry.record };
}

/**
 * The drive running on this session, if any. An unnamed session matches any running drive, and a
 * drive started without one matches any session: either way it is the tab a second start would use.
 */
export function runningDrive(sessionId: string | undefined): DriveRecord | undefined {
  for (const entry of entries.values()) {
    if (DriveStatus.RUNNING !== entry.record.status) continue;
    const own = entry.record.sessionId;
    if (sessionId === undefined || own === undefined || own === sessionId)
      return { ...entry.record };
  }
  return undefined;
}

/** Every drive still running, for the HUD. */
export function runningDrives(): DriveRecord[] {
  return [...entries.values()]
    .filter((entry) => DriveStatus.RUNNING === entry.record.status)
    .map((entry) => ({ ...entry.record }));
}

/**
 * Wait until the drive ends, `ms` passes (no limit when undefined), or `signal` aborts — whichever
 * is first. Ending the wait never ends the drive. `onChange` hears every step while waiting.
 */
export function awaitDrive(
  runId: string,
  ms: number | undefined,
  signal?: AbortSignal,
  onChange?: (record: DriveRecord) => void,
): Promise<void> {
  const entry = entries.get(runId);
  if (entry === undefined || DriveStatus.RUNNING !== entry.record.status) return Promise.resolve();
  return new Promise((resolve) => {
    const waiter = (record: DriveRecord): void => {
      onChange?.(record);
      if (DriveStatus.RUNNING !== record.status) done();
    };
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      entry.waiters.delete(waiter);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = ms === undefined ? undefined : setTimeout(done, ms);
    entry.waiters.add(waiter);
    signal?.addEventListener('abort', done, { once: true });
    if (true === signal?.aborted) done();
  });
}

/** Ask a running drive to stop. False when there is no such drive running. */
export function stopDrive(runId: string): boolean {
  const entry = entries.get(runId);
  if (entry === undefined || DriveStatus.RUNNING !== entry.record.status) return false;
  entry.abort.abort();
  return true;
}

/** Queue text for the driver's next turn. False when there is no such drive running. */
export function sayToDrive(runId: string, text: string): boolean {
  const entry = entries.get(runId);
  if (entry === undefined || DriveStatus.RUNNING !== entry.record.status) return false;
  entry.inbox.push(text);
  return true;
}

/** One tool call a drive made. `harness` may be a lane's id (`<harness>-L2`). */
export function noteDriveStep(harness: string, tool: string): void {
  const entry = entryFor(harness);
  if (entry === undefined) return;
  entry.record.steps += 1;
  entry.record.lastLine = `step ${String(entry.record.steps)} · ${tool}`;
  changed(entry, false);
}

/** A line the drive narrated to the HUD. */
export function noteDriveLine(harness: string, line: string): void {
  const entry = entryFor(harness);
  if (entry === undefined) return;
  entry.record.lastLine = line;
  changed(entry, false);
}

/** Hear every drive start and end, from any origin. Returns the unsubscribe. */
export function onDriveChange(listener: (record: DriveRecord) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/**
 * The notes the agent has not heard: a drive started or finished, from any origin. Taken once.
 * `except` is the run the agent is already reading, which needs no note about itself.
 */
export function takeDriveNotes(except?: string): string[] {
  if (except !== undefined) notes.delete(except);
  const taken = [...notes.values()];
  notes.clear();
  return taken;
}

/** Tests only: every drive and note forgotten. */
export function forgetDrives(): void {
  entries.clear();
  byHarness.clear();
  notes.clear();
}

function entryFor(harness: string): Entry | undefined {
  return byHarness.get(harness) ?? byHarness.get(harness.replace(LANE_SUFFIX, ''));
}

/** Waiters hear every change; an agent and the HUD only hear a start or an end. */
function changed(entry: Entry, startOrEnd: boolean): void {
  const record = { ...entry.record };
  for (const waiter of [...entry.waiters]) waiter(record);
  if (!startOrEnd) return;
  notes.set(record.harnessRun, noteFor(record));
  for (const listener of changeListeners) {
    try {
      listener(record);
    } catch {
      /* a listener never breaks the drive it listens to */
    }
  }
}

function noteFor(record: DriveRecord): string {
  const poll = `→ ${ReticleTool.VERIFY} {action:"explore", runId:"${record.harnessRun}"}`;
  if (DriveStatus.RUNNING === record.status)
    return `harness drive ${record.harnessRun} running ${poll}`;
  return `harness drive ${record.harnessRun} finished (${summaryOf(record)}) ${poll}`;
}

function summaryOf(record: DriveRecord): string {
  if (record.error !== undefined) return `${record.status}: ${record.error}`;
  const checks = record.result?.['checks'];
  if ('object' !== typeof checks || null === checks) return record.status;
  const count = (key: string): string => {
    const n = (checks as Record<string, unknown>)[key];
    return String('number' === typeof n ? n : 0);
  };
  return `${record.status}: ${count('held')} held, ${count('failed')} failed, ${count('undecided')} undecided`;
}

function prune(): void {
  const finished = [...entries.entries()].filter(
    ([, entry]) => DriveStatus.RUNNING !== entry.record.status,
  );
  for (const [runId, entry] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
    entries.delete(runId);
    byHarness.delete(entry.harness);
  }
}

/** The impact snapshot, with the drive running on this tab when there is one. */
export function withRunningDrive(
  snapshot: ImpactSnapshot | undefined,
  sessionId: string,
): ImpactSnapshot | undefined {
  const running = runningDrive(sessionId);
  if (running === undefined || snapshot === undefined) return snapshot;
  const drive: HarnessDrive = { runId: running.harnessRun, steps: running.steps };
  return { ...snapshot, harnessDrive: drive };
}
