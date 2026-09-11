import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readAccountState } from '../cloud/account-state.js';
import {
  ReticleDir,
  IMPACT_DAILY_BUCKETS,
  IMPACT_DEFECT_LIMIT,
  IMPACT_SCHEMA_VERSION,
  ImpactScopeSchema,
  addImpactCounts,
  emptyImpactCounts,
  emptyImpactRecords,
  estimateImpactSavings,
  type ImpactCounts,
  type ImpactDefect,
  type AccountState,
  type ImpactScope,
  type ImpactSnapshot,
} from '@reticlehq/core';

/**
 * Where Reticle keeps the record of what it has done for you.
 *
 * Two scopes, two files, both local and never uploaded: the project's own `.reticle/impact.json`,
 * and a machine-wide `~/.reticle/impact.json` that answers "what has Reticle done for me overall"
 * across every app you have instrumented.
 *
 * This is NOT telemetry. Telemetry answers our questions about the product and leaves the machine;
 * this answers the user's question about their own work and never does.
 */

/** Writes are debounced: a verification loop is 50-200 calls, and each one is a counter bump. */
const WRITE_DEBOUNCE_MS = 800;

/** The project's cloud binding, written by `reticle link`. Absent for an unlinked project. */
const CLOUD_LINK_FILE = 'cloud.json';

interface ImpactPaths {
  project: string;
  global: string;
}

/**
 * `reticleRoot` is the project's own `.reticle` directory (what every other store here is handed);
 * the global scope lives beside the daemon's own state in `~/.reticle`.
 *
 * `globalRoot` defaults to the home directory and exists to be overridden. Reaching for `homedir()`
 * implicitly made the machine-wide scope untestable — the one scope with a concurrency bug in it —
 * so the seam is the fix's precondition, not a test affordance.
 */
function impactPaths(reticleRoot: string, globalRoot: string): ImpactPaths {
  return {
    project: join(reticleRoot, ReticleDir.IMPACT_FILE),
    global: join(globalRoot, ReticleDir.ROOT, ReticleDir.IMPACT_FILE),
  };
}

/**
 * Where this project's dashboard lives, if `reticle link` recorded one.
 *
 * Read from the link file rather than derived from the API url, because the API origin and the
 * console origin are different hosts in every deployment that is not a laptop. Synchronous and
 * best-effort, like every other read in this file: a missing or malformed link file means no link
 * in the HUD, never a failed tool call.
 */
function readDashboardUrl(reticleRoot: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(reticleRoot, CLOUD_LINK_FILE), 'utf8'));
    if ('object' !== typeof raw || null === raw) return undefined;
    const value = (raw as Record<string, unknown>)['dashboardUrl'];
    return 'string' === typeof value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function emptyScope(now: number): ImpactScope {
  const counts = emptyImpactCounts();
  return {
    counts,
    days: [],
    records: emptyImpactRecords(),
    savings: estimateImpactSavings(counts),
    since: now,
    defects: [],
  };
}

/** Read a scope, tolerating absence and corruption: a broken file starts over rather than throwing. */
export function readScope(path: string, now: number): ImpactScope {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const result = ImpactScopeSchema.safeParse(parsed);
    return result.success ? result.data : emptyScope(now);
  } catch {
    return emptyScope(now);
  }
}

/**
 * Write a scope atomically.
 *
 * tmp + rename, because two daemons can serve two apps in the same repo at once and a half-written
 * counters file is one the next read discards - silently losing the whole history.
 */
function writeScope(path: string, scope: ImpactScope): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(scope, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch {
    // A stats file that cannot be written must never break a tool call. The counters stay in
    // memory and the next write attempt carries them.
  }
}

/** YYYY-MM-DD in local time - the day boundary a person recognises, not UTC's. */
export function isoDay(now: number): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(d.getFullYear())}-${month}-${day}`;
}

/** Whether `b` is the calendar day right after `a` - the streak rule. */
function isNextDay(a: string, b: string): boolean {
  const prev = new Date(`${a}T00:00:00`);
  const next = new Date(`${b}T00:00:00`);
  return 1 === Math.round((next.getTime() - prev.getTime()) / 86_400_000);
}

/**
 * What a fold knows beyond the counters.
 *
 * `runMs` is a SESSION's lifetime, and it only ever feeds the "longest run" record. It is not a
 * counter: adding it to a total would answer a question nobody asked, and the record used to be fed
 * a single tool call's duration instead, which made the report's superlative a number of
 * milliseconds that never grew past one click.
 */
export interface ImpactFoldMeta {
  runMs?: number;
  /**
   * The defect this call caught, when it caught one. Carried beside the counters rather than in
   * them because it is not a tally: `counts.failed` says how many, this says which.
   */
  defect?: ImpactDefect;
}

/** Fold one delta into a scope: totals, today's bucket, records and streak. Pure. */
export function applyDelta(
  scope: ImpactScope,
  delta: Partial<ImpactCounts>,
  now: number,
  meta: ImpactFoldMeta = {},
): ImpactScope {
  const today = isoDay(now);
  const counts = addImpactCounts(scope.counts, delta);
  const days = scope.days.slice();
  const last = days[days.length - 1];
  if (last !== undefined && last.date === today) {
    days[days.length - 1] = { date: today, counts: addImpactCounts(last.counts, delta) };
  } else {
    days.push({ date: today, counts: addImpactCounts(emptyImpactCounts(), delta) });
  }
  while (days.length > IMPACT_DAILY_BUCKETS) days.shift();

  const todayCounts = days[days.length - 1]?.counts ?? emptyImpactCounts();
  const previousDay = days[days.length - 2];
  const records = { ...scope.records };
  records.bestVerdictDay = Math.max(records.bestVerdictDay, todayCounts.verdicts);
  records.bestDefectDay = Math.max(records.bestDefectDay, todayCounts.failed);
  if (last === undefined || last.date !== today) {
    // A new day joins the streak only if it follows yesterday; otherwise it starts a new one.
    records.streakDays =
      previousDay !== undefined && isNextDay(previousDay.date, today) ? records.streakDays + 1 : 1;
  } else if (0 === records.streakDays) {
    records.streakDays = 1;
  }
  records.bestStreakDays = Math.max(records.bestStreakDays, records.streakDays);
  records.longestRunMs = Math.max(records.longestRunMs, meta.runMs ?? 0);

  /*
   * Newest first, capped. Prepending is what makes the HUD's short list the CURRENT breakage rather
   * than the first ten things that ever broke — which, after a week, is a list about the past.
   */
  const defects =
    meta.defect === undefined
      ? scope.defects
      : [meta.defect, ...scope.defects].slice(0, IMPACT_DEFECT_LIMIT);

  return {
    counts,
    days,
    records,
    savings: estimateImpactSavings(counts),
    since: scope.since,
    defects,
  };
}

/**
 * The live impact record for one project.
 *
 * Holds both scopes in memory, folds deltas in synchronously (so a reader always sees the truth),
 * and flushes to disk on a debounce.
 */
export class ImpactStore {
  readonly #paths: ImpactPaths;
  readonly #now: () => number;
  readonly #projectName: string | undefined;
  readonly #dashboardUrl: string | undefined;
  #project: ImpactScope;
  #global: ImpactScope;
  /**
   * Deltas folded since the last machine-wide write, kept so the write can be a MERGE.
   *
   * The project scope has one writer and can be written wholesale. The machine-wide file is shared
   * by every daemon on the box, so writing an in-memory copy taken at construction erases whatever a
   * sibling wrote in between — which is what made the machine streak read LOWER than a single
   * project's. Replaying these onto whatever is on disk at flush time is what makes the write additive.
   */
  #pendingGlobal: { delta: Partial<ImpactCounts>; now: number; meta: ImpactFoldMeta }[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #onChange: (() => void) | undefined;
  readonly #account: () => AccountState;

  constructor(opts: {
    reticleRoot: string;
    projectName?: string;
    now?: () => number;
    /** Where `~/.reticle` lives. Defaults to the real home; overridden so the shared scope is testable. */
    globalRoot?: string;
    /** Reads whether this machine is signed in. Injected so the store stays testable and pure-ish. */
    account?: () => AccountState;
  }) {
    this.#paths = impactPaths(opts.reticleRoot, opts.globalRoot ?? homedir());
    // Resolved per snapshot, not cached: a user who runs `reticle login` in another terminal must
    // see the HUD change without restarting the daemon that is watching their app.
    this.#account = opts.account ?? ((): AccountState => readAccountState(homedir(), process.env));
    this.#now = opts.now ?? ((): number => Date.now());
    this.#projectName = opts.projectName;
    this.#dashboardUrl = readDashboardUrl(opts.reticleRoot);
    const now = this.#now();
    this.#project = readScope(this.#paths.project, now);
    this.#global = readScope(this.#paths.global, now);
  }

  /** Notified after every fold, so the HUD can be pushed a fresh snapshot. */
  onChange(fn: () => void): void {
    this.#onChange = fn;
  }

  record(delta: Partial<ImpactCounts>, meta: ImpactFoldMeta = {}): void {
    const now = this.#now();
    this.#project = applyDelta(this.#project, delta, now, meta);
    // Folded in memory so a reader sees it immediately, AND buffered so the durable write can replay
    // it onto a file a sibling may have moved on since. The in-memory copy is rebased at flush.
    this.#global = applyDelta(this.#global, delta, now, meta);
    this.#pendingGlobal.push({ delta, now, meta });
    this.#scheduleFlush();
    this.#onChange?.();
  }

  snapshot(): ImpactSnapshot {
    const snap: ImpactSnapshot = {
      schemaVersion: IMPACT_SCHEMA_VERSION,
      project: this.#project,
      global: this.#global,
    };
    if (this.#projectName !== undefined) snap.projectName = this.#projectName;
    if (this.#dashboardUrl !== undefined) snap.dashboardUrl = this.#dashboardUrl;
    snap.account = this.#account();
    return snap;
  }

  /** Write now (process exit, tests). */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // One writer: the in-memory copy IS the truth.
    writeScope(this.#paths.project, this.#project);
    this.#flushGlobal();
  }

  /**
   * Publish this store's contribution to the machine-wide scope WITHOUT discarding anyone else's.
   *
   * Re-reads what is on disk and replays only the deltas recorded since the last write, so a sibling
   * daemon's day survives. The merged result is adopted in memory too, which is what keeps the HUD's
   * "everything on this machine" honest rather than showing this process's private view forever.
   *
   * ponytail: read-modify-write, not locked. Two daemons flushing inside the same read→rename window
   * can still drop one batch — far rarer than the every-second-flush loss this replaces, and it costs
   * one debounce window rather than a whole history. Upgrade to a lock file (exclusive `wx` create
   * plus a stale timeout) if the counters are ever load-bearing for anything but the HUD.
   */
  #flushGlobal(): void {
    if (0 === this.#pendingGlobal.length) return;
    const merged = this.#pendingGlobal.reduce(
      (scope, p) => applyDelta(scope, p.delta, p.now, p.meta),
      readScope(this.#paths.global, this.#now()),
    );
    writeScope(this.#paths.global, merged);
    this.#global = merged;
    this.#pendingGlobal = [];
  }

  #scheduleFlush(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
    this.#timer.unref?.();
  }
}
