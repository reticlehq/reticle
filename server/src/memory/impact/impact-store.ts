import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  SyncStatus,
  dashboardRunUrl,
  describeSync,
  overallStatus,
  readSyncSummary,
} from '@/memory/project/sync-status.js';
import { describeUnsynced, unsentRunCount } from '@/memory/cloud/unsynced-roots.js';
import { readDashboardUrl } from '@/memory/cloud/cloud-config.js';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readAccountState } from '@/memory/cloud/account-state.js';
import { harnessOfferSource, type OfferSource } from '@/memory/cloud/harness-offer.js';
import type { ConfigSource } from '@/memory/cloud/harness-config.js';
import { hudNoticesSource, type NoticesSource } from '@/memory/cloud/hud-notices-source.js';
import { selectNotices } from '@reticlehq/core/hud';
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
 * Two scopes, two files: the project's own `.reticle/impact.json`, and a machine-wide
 * `~/.reticle/impact.json` that answers "what has Reticle done for me overall" across every app you
 * have instrumented.
 *
 * This is NOT telemetry. Telemetry answers our questions about the product; this answers the user's
 * question about their own work. A linked project's record syncs to that user's own dashboard (the
 * sync cycle's `impact` kind); the machine-wide record never leaves the machine.
 */

/** Writes are debounced: a verification loop is 50-200 calls, and each one is a counter bump. */
const WRITE_DEBOUNCE_MS = 800;

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

/** The daemon's cached copy of the HUD notices file, beside the machine-wide impact record. */
const HUD_NOTICES_CACHE_FILE = 'hud-notices.json';
/** How long a sync status is reused before it is read again. */
const SYNC_STATUS_EVERY_MS = 10_000;
/** When the caller did not say which build this is: matches only notices with no `minSdk`. */
const UNKNOWN_SDK_VERSION = '0.0.0';

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
 * Consecutive days ending at the newest recorded day, read from the days themselves.
 *
 * It was a counter bumped when a fold opened a new day and compared only with the bucket before it,
 * so one stray day in between (a late flush from another daemon, a writer with a frozen clock) reset
 * it to 1. Counting back from the newest date means no out-of-order write can shorten it.
 */
function streakEndingAtLatest(sortedDates: readonly string[]): number {
  let streak = 0;
  let later: string | undefined;
  for (let i = sortedDates.length - 1; i >= 0; i -= 1) {
    const date = sortedDates[i];
    if (date === undefined) break;
    if (later !== undefined && !isNextDay(date, later)) break;
    streak += 1;
    later = date;
  }
  return streak;
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
  // One bucket per date, wherever the delta's date falls. The machine-wide record has many writers
  // and a late flush carries an older date, so "the last bucket is today" is not something a fold
  // may assume — appending on that assumption duplicated dates and put them out of order.
  const byDate = new Map<string, ImpactCounts>();
  for (const day of scope.days) {
    byDate.set(day.date, addImpactCounts(byDate.get(day.date) ?? emptyImpactCounts(), day.counts));
  }
  const todayCounts = addImpactCounts(byDate.get(today) ?? emptyImpactCounts(), delta);
  byDate.set(today, todayCounts);
  const dates = [...byDate.keys()].sort();
  const days = dates.map((date) => ({ date, counts: byDate.get(date) ?? emptyImpactCounts() }));
  while (days.length > IMPACT_DAILY_BUCKETS) days.shift();

  const records = { ...scope.records };
  records.bestVerdictDay = Math.max(records.bestVerdictDay, todayCounts.verdicts);
  records.bestDefectDay = Math.max(records.bestDefectDay, todayCounts.failed);
  // The window keeps IMPACT_DAILY_BUCKETS days, so a streak longer than it cannot be read off the
  // dates alone: when the whole window is one unbroken run, it continues the streak already held.
  const inWindow = streakEndingAtLatest(dates);
  const unbroken = inWindow === dates.length && scope.days.length >= IMPACT_DAILY_BUCKETS;
  const newDay = !scope.days.some((day) => day.date === today);
  records.streakDays = unbroken
    ? Math.max(inWindow, scope.records.streakDays + (newDay ? 1 : 0))
    : inWindow;
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

/** The larger of two counters, key by key. */
function maxEach<T extends Record<string, number>>(a: T, b: T): T {
  const out = { ...a };
  for (const key of Object.keys(b) as (keyof T)[])
    out[key] = Math.max(a[key] ?? 0, b[key] ?? 0) as T[keyof T];
  return out;
}

/**
 * All time, never smaller than the project being looked at.
 *
 * The two scopes live in different files: the project's in its `.reticle`, the machine's in the
 * home directory. A project whose history began before this machine's ledger (an upgrade, a new
 * laptop, a moved checkout) showed more under "This project" than under "All time", which no reader
 * can believe. The machine has done at least what any one of its projects has.
 */
export function atLeastProject(global: ImpactScope, project: ImpactScope): ImpactScope {
  // The earlier of the two starts; zero is "never recorded", not the epoch.
  const starts = [global.since, project.since].filter((t) => 0 < t);
  return {
    ...global,
    counts: maxEach(global.counts, project.counts),
    records: maxEach(global.records, project.records),
    savings: {
      tokens: {
        ...global.savings.tokens,
        value: Math.max(global.savings.tokens.value, project.savings.tokens.value),
      },
      minutes: {
        ...global.savings.minutes,
        value: Math.max(global.savings.minutes.value, project.savings.minutes.value),
      },
    },
    since: 0 === starts.length ? 0 : Math.min(...starts),
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
  readonly #root: string;
  /** The sync status, re-read at most every SYNC_STATUS_EVERY_MS: it reads every run file. */
  #sync: { at: number; value: Record<string, unknown> | undefined } | undefined;
  readonly #now: () => number;
  readonly #projectName: string | undefined;
  #dashboardUrl: string | undefined;
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
  /** Where this workspace stands with the free harness offer. Cached; see harness-offer.ts. */
  readonly #offer: OfferSource;
  readonly #config: ConfigSource;
  readonly #notices: NoticesSource;
  readonly #sdkVersion: string;
  readonly #coverage: (() => Record<string, number> | undefined) | undefined;

  constructor(opts: {
    reticleRoot: string;
    projectName?: string;
    now?: () => number;
    /** Where `~/.reticle` lives. Defaults to the real home; overridden so the shared scope is testable. */
    globalRoot?: string;
    /** Reads whether this machine is signed in. Injected so the store stays testable and pure-ish. */
    account?: () => AccountState;
    /** Where the workspace stands with the free harness offer. Injected so no test touches a network. */
    offer?: OfferSource;
    config?: ConfigSource;
    /** The HUD rail's notices. Defaults to the daemon's cached copy of the published file. */
    notices?: NoticesSource;
    /** This build's version, for notices that need a newer SDK. Passed in: the store reads no package. */
    sdkVersion?: string;
    /** Reticle Coverage per level, as percentages. Injected: the ledger lives in `features/exhaust`. */
    coverage?: () => Record<string, number> | undefined;
  }) {
    this.#coverage = opts.coverage;
    this.#paths = impactPaths(opts.reticleRoot, opts.globalRoot ?? homedir());
    // Resolved per snapshot, not cached: a user who runs `reticle login` in another terminal must
    // see the HUD change without restarting the daemon that is watching their app.
    this.#account = opts.account ?? ((): AccountState => readAccountState(homedir(), process.env));
    this.#now = opts.now ?? ((): number => Date.now());
    this.#projectName = opts.projectName;
    this.#dashboardUrl = readDashboardUrl(opts.reticleRoot);
    this.#root = opts.reticleRoot;
    // The claim happens in the console, so the link this project was linked to IS the claim link —
    // built here rather than in the HUD, which has no way to know where this project points.
    this.#offer = opts.offer ?? harnessOfferSource(process.env, () => this.#dashboardUrl);
    this.#notices =
      opts.notices ??
      hudNoticesSource({
        cacheFile: join(opts.globalRoot ?? homedir(), ReticleDir.ROOT, HUD_NOTICES_CACHE_FILE),
      });
    this.#sdkVersion = opts.sdkVersion ?? UNKNOWN_SDK_VERSION;
    // No default: the loader lives in `features/harness` and this file may not reach for it.
    // A store built without one simply reports no harness config, which the HUD renders as no row.
    this.#config = opts.config ?? { read: () => undefined };
    const now = this.#now();
    this.#project = readScope(this.#paths.project, now);
    this.#global = readScope(this.#paths.global, now);
  }

  #syncStatus(dashboardUrl: string | undefined): Record<string, unknown> | undefined {
    const now = this.#now();
    if (this.#sync !== undefined && now - this.#sync.at < SYNC_STATUS_EVERY_MS)
      return this.#sync.value;
    // Not linked: one line when runs sit here that nothing will send, and nothing otherwise.
    if (dashboardUrl === undefined) {
      const unsent = unsentRunCount(this.#root);
      const value =
        0 === unsent
          ? undefined
          : {
              status: SyncStatus.LOCAL_ONLY,
              pending: unsent,
              said: describeUnsynced(
                { root: this.#root, runs: unsent, linked: false },
                dirname(this.#root),
              ),
            };
      this.#sync = { at: now, value };
      return value;
    }
    const summary = readSyncSummary(this.#root, true);
    const latest = summary.latestOnPlatform;
    const value = {
      status: overallStatus(summary),
      runs: summary.runs,
      onPlatform: summary.onPlatform,
      pending: summary.pending,
      refused: summary.refused.length + summary.refusedMore,
      ...(summary.lastPushAt === undefined ? {} : { lastPushAt: summary.lastPushAt }),
      // The run that just synced, on its own page — the HUD's "see it in your dashboard".
      ...(latest === undefined ? {} : { runUrl: dashboardRunUrl(dashboardUrl, latest) }),
      said: describeSync(summary, now),
    };
    this.#sync = { at: now, value };
    return value;
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
      global: atLeastProject(this.#global, this.#project),
    };
    if (this.#projectName !== undefined) snap.projectName = this.#projectName;
    // Re-read, like the account: `reticle link` runs in another terminal while this store lives as
    // long as the daemon, so a construction-time read said "Not linked" until a restart.
    this.#dashboardUrl = readDashboardUrl(this.#root);
    if (this.#dashboardUrl !== undefined) snap.dashboardUrl = this.#dashboardUrl;
    snap.account = this.#account();
    const cfgForOffer = this.#config.read();
    const offer = this.#offer.read();
    // Joined here because this is the one place that holds BOTH the offer and the platform config.
    // The card reads the offer, so readiness has to travel on it rather than being re-derived in a
    // presenter that has no business knowing what a provider key is.
    if (offer !== undefined && cfgForOffer !== undefined)
      offer.drivable = cfgForOffer.providerReady;
    // Absent means "we have not heard", which the HUD renders as nothing at all. Never defaulted to
    // `{claimed:false}`: that would advertise the offer to everyone who is offline.
    if (offer !== undefined) snap.harnessOffer = offer;
    // Absent stays absent: the HUD reads that as "we have not heard" and renders no control.
    const cfg = this.#config.read();
    if (cfg !== undefined) snap.harnessConfig = cfg;
    // Chosen here, where the account and the entitlement are both known. Absent when nothing applies,
    // so the HUD falls back to the slides bundled with the SDK.
    const notices = selectNotices(this.#notices.read(), {
      signedIn: snap.account?.signedIn,
      entitled: cfg?.harnessEntitled,
      sdkVersion: this.#sdkVersion,
      now: this.#now(),
    });
    if (0 < notices.length) snap.notices = notices;
    const coverage = this.#coverage?.();
    if (coverage !== undefined) snap.coverage = coverage;
    // Only for a linked project: an unlinked one has nothing on the platform, and the HUD already
    // offers the way to link it.
    const sync = this.#syncStatus(this.#dashboardUrl);
    if (sync !== undefined) snap.sync = sync;
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
