/**
 * The app-wide coverage ledger: what "everything" is, and how much of it has been proved.
 *
 * "Done" used to be the agent's opinion, which is the root of shallow verification: every rule it
 * read pushed it to stop, and nothing it could read said what was left. This makes it a number per
 * level, each with the missing items named, accumulated across every drive and every session.
 *
 * Six levels, each stricter than the last, and never averaged — an average is exactly how "the
 * controls were clicked" hides "none of them were proved":
 *
 *   reached   — routes rendered, of routes discovered
 *   touched   — controls acted on, of controls seen
 *   proved    — controls with a `yes` verdict on a declared consequence, of controls seen
 *   completed — journeys proved at their end (count only: there is no honest denominator)
 *   branched  — writes whose FAILURE path was driven, of writes seen
 *   executed  — app functions that ran, of app functions loaded
 *
 * Union-only. A later drive can add coverage and never remove it, so the number only moves down when
 * the app grows something nobody has covered yet — which is precisely what the ratchet is for.
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '@/memory/project/fs/write-atomic.js';
import { withFileLock } from '@/memory/project/file-lock.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import type { CodeCoverage } from './code-coverage.js';

export const CoverageLevel = {
  REACHED: 'reached',
  TOUCHED: 'touched',
  PROVED: 'proved',
  COMPLETED: 'completed',
  BRANCHED: 'branched',
  EXECUTED: 'executed',
} as const;
export type CoverageLevel = (typeof CoverageLevel)[keyof typeof CoverageLevel];

const LEDGER_VERSION = 1;
/** How many missing items a level names before it only counts them. */
export const MAX_MISSING = 50;

const names = z.array(z.string());

/** A behaviour fault the explorer found. See `invariants.ts`, which produces these. */
export const BehaviourFindingSchema = z.object({
  /** A `BehaviourFindingKind` from core, or the kind of a fault an edge case caused (`console-error`). */
  kind: z.string(),
  /** The rule that did not hold, in words. */
  invariant: z.string(),
  detail: z.string(),
  /** The steps that show it, from a fresh page. */
  sequence: z.array(z.string()),
  /** `file:line` of the element, when the app gives source attribution. */
  source: z.string().optional(),
  /** True when the fault did not occur on every run. */
  intermittent: z.boolean().optional(),
});
export type BehaviourFinding = z.infer<typeof BehaviourFindingSchema>;

const LedgerSchema = z.object({
  routes: z.object({ discovered: names, reached: names }),
  controls: z.object({ seen: names, touched: names, proved: names }),
  journeys: z.object({ completed: names }),
  writes: z.object({ seen: names, branched: names, unhandled: names }),
  /** Controls whose edge cases (edge inputs, edge interactions) were driven. */
  edges: z.object({ probed: names }).default({ probed: [] }),
  /** Behaviour faults, one copy each. Absent in a ledger from before they existed. */
  findings: z.array(BehaviourFindingSchema).default([]),
  code: z.record(
    z.string(),
    z.record(z.string(), z.object({ name: z.string(), executed: z.boolean() })),
  ),
  /** Per file, when its code coverage was last taken. Absent in a ledger from before it existed. */
  codeTaken: z.record(z.string(), z.number()).default({}),
  best: z.record(z.string(), z.number()),
});
export type AppLedger = z.infer<typeof LedgerSchema>;

/** What one producer contributes. Every part optional: a drive adds what it saw and nothing else. */
export interface LedgerDelta {
  routes?: Partial<AppLedger['routes']>;
  controls?: Partial<AppLedger['controls']>;
  journeys?: Partial<AppLedger['journeys']>;
  writes?: Partial<AppLedger['writes']>;
  edges?: Partial<AppLedger['edges']>;
  findings?: readonly BehaviourFinding[];
  code?: CodeCoverage;
  /** When `code` was taken, so a file edited since reads as not measured rather than as covered. */
  codeTakenAt?: number;
}

export interface LevelReport {
  level: CoverageLevel;
  covered: number;
  /** Absent where no honest denominator exists. */
  total?: number;
  /** Absent when nothing was measured: 0 of 0 is not 100%. */
  pct?: number;
  missing: string[];
  /** How many more are missing than `missing` names. */
  missingOverflow?: number;
}

/** A ledger file's text, or an empty ledger for anything unreadable: coverage never throws. */
function parseLedger(text: string): AppLedger {
  try {
    const parsed = z
      .object({ version: z.literal(LEDGER_VERSION), ledger: LedgerSchema })
      .safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.ledger : emptyLedger();
  } catch {
    return emptyLedger();
  }
}

/**
 * Each level's percentage for the project at `reticleRoot`, for the HUD: numbers only, and only the
 * levels with an honest denominator. Undefined when nothing has been measured yet.
 *
 * Synchronous because the impact snapshot it feeds is: one small file read per snapshot.
 */
export function coveragePercents(reticleRoot: string): Record<string, number> | undefined {
  let text: string;
  try {
    text = readFileSync(reticleDirPaths(reticleRoot).coverage, 'utf8');
  } catch {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const report of levelsOf(parseLedger(text))) {
    if (report.pct !== undefined) {
      out[report.level] = report.pct;
    }
  }
  return 0 < Object.keys(out).length ? out : undefined;
}

export function emptyLedger(): AppLedger {
  return {
    routes: { discovered: [], reached: [] },
    controls: { seen: [], touched: [], proved: [] },
    journeys: { completed: [] },
    writes: { seen: [], branched: [], unhandled: [] },
    edges: { probed: [] },
    findings: [],
    code: {},
    codeTaken: {},
    best: {},
  };
}

const union = (a: readonly string[], b: readonly string[] | undefined): string[] =>
  b === undefined ? [...a] : [...new Set([...a, ...b])];

/** The same fault found again by the same steps is one finding; the first copy is kept. */
const findingKey = (f: BehaviourFinding): string => `${f.kind}\n${f.sequence.join('\n')}`;

function unionFindings(
  into: readonly BehaviourFinding[],
  add: readonly BehaviourFinding[] | undefined,
): BehaviourFinding[] {
  const out = [...into];
  const keys = new Set(out.map(findingKey));
  for (const f of add ?? []) {
    if (!keys.has(findingKey(f))) {
      keys.add(findingKey(f));
      out.push(f);
    }
  }
  return out;
}

export function mergeLedger(into: AppLedger, delta: LedgerDelta): AppLedger {
  const code: CodeCoverage = { ...into.code };
  const codeTaken = { ...into.codeTaken };
  for (const [file, fns] of Object.entries(delta.code ?? {})) {
    const merged = { ...(code[file] ?? {}) };
    for (const [key, fn] of Object.entries(fns)) {
      merged[key] = { name: fn.name, executed: fn.executed || true === merged[key]?.executed };
    }
    code[file] = merged;
    if (delta.codeTakenAt !== undefined) {
      codeTaken[file] = delta.codeTakenAt;
    }
  }
  // Reaching a route discovers it; touching or proving a control means it was seen. Probing a
  // control's edge cases drove it, so it was touched.
  const reached = union(into.routes.reached, delta.routes?.reached);
  const probed = union(into.edges.probed, delta.edges?.probed);
  const touched = union(union(into.controls.touched, delta.controls?.touched), probed);
  const proved = union(into.controls.proved, delta.controls?.proved);
  const branched = union(into.writes.branched, delta.writes?.branched);
  return {
    routes: {
      discovered: union(union(into.routes.discovered, delta.routes?.discovered), reached),
      reached,
    },
    controls: {
      seen: union(union(union(into.controls.seen, delta.controls?.seen), touched), proved),
      touched: union(touched, proved),
      proved,
    },
    journeys: { completed: union(into.journeys.completed, delta.journeys?.completed) },
    writes: {
      seen: union(union(into.writes.seen, delta.writes?.seen), branched),
      branched,
      unhandled: union(into.writes.unhandled, delta.writes?.unhandled),
    },
    edges: { probed },
    findings: unionFindings(into.findings, delta.findings),
    code,
    codeTaken,
    best: { ...into.best },
  };
}

function level(
  name: CoverageLevel,
  universe: readonly string[],
  covered: readonly string[],
): LevelReport {
  const done = new Set(covered);
  const missing = universe.filter((item) => !done.has(item));
  const count = universe.length - missing.length;
  return {
    level: name,
    covered: count,
    total: universe.length,
    ...(0 === universe.length ? {} : { pct: Math.round((100 * count) / universe.length) }),
    missing: missing.slice(0, MAX_MISSING),
    ...(missing.length > MAX_MISSING ? { missingOverflow: missing.length - MAX_MISSING } : {}),
  };
}

/** Functions are identified by file + key (names repeat) and reported by file + name. */
function executedLevel(code: CodeCoverage): LevelReport {
  const fns = Object.entries(code).flatMap(([file, map]) =>
    Object.values(map).map((fn) => ({ label: `${file}: ${fn.name}`, executed: fn.executed })),
  );
  const missing = fns.filter((fn) => !fn.executed).map((fn) => fn.label);
  const covered = fns.length - missing.length;
  return {
    level: CoverageLevel.EXECUTED,
    covered,
    total: fns.length,
    ...(0 === fns.length ? {} : { pct: Math.round((100 * covered) / fns.length) }),
    missing: missing.slice(0, MAX_MISSING),
    ...(missing.length > MAX_MISSING ? { missingOverflow: missing.length - MAX_MISSING } : {}),
  };
}

export function levelsOf(ledger: AppLedger): LevelReport[] {
  return [
    level(CoverageLevel.REACHED, ledger.routes.discovered, ledger.routes.reached),
    level(CoverageLevel.TOUCHED, ledger.controls.seen, ledger.controls.touched),
    level(CoverageLevel.PROVED, ledger.controls.seen, ledger.controls.proved),
    { level: CoverageLevel.COMPLETED, covered: ledger.journeys.completed.length, missing: [] },
    level(CoverageLevel.BRANCHED, ledger.writes.seen, ledger.writes.branched),
    executedLevel(ledger.code),
  ];
}

/**
 * What was never reached, as named items: the holes in the exploration.
 *
 * The levels above give a number per level. A number does not say where to go next, and it hides a
 * level that was never measured behind an empty list. `holesOf` names every gap by kind, says when
 * a kind was not measured at all, and counts the items past its cap. Nothing is left out in silence.
 */
export const HoleKind = {
  /** Routes discovered and never visited. */
  ROUTES: 'routes',
  /** Controls seen and never driven. */
  CONTROLS: 'controls',
  /** Controls seen whose edge cases were never driven. */
  EDGES: 'edges',
  /** Writes seen whose failure path was never driven. */
  WRITES: 'writes',
  /** App functions loaded and never executed, as `file: function`. */
  FUNCTIONS: 'functions',
  /** Components the app has and never rendered. */
  COMPONENTS: 'components',
} as const;
export type HoleKind = (typeof HoleKind)[keyof typeof HoleKind];

export interface HoleList {
  /** False when nothing could measure this kind: an empty list then means "unknown", not "none". */
  measured: boolean;
  items: string[];
  /** How many more items there are than `items` names. */
  overflow?: number;
  /** Why the kind is not measured, or what to do to measure it. */
  note?: string;
}

export type HolesReport = Record<HoleKind, HoleList>;

/** The React adapter's component inventory: every component it knows, and the ones it rendered. */
export interface ComponentInventory {
  known: readonly string[];
  rendered: readonly string[];
}

export const HoleNote = {
  CODE: 'Not measured: code coverage needs a browser Reticle drives (`reticle drive`, or RETICLE_CDP_URL).',
  COMPONENTS:
    'Not measured: no component inventory is available. A component that never rendered still shows in `functions` when code coverage is on.',
  EDGES:
    'No edge cases were driven yet. Run `reticle_crawl { exhaustive: true }`; every control listed here is still a hole.',
} as const;

function named(universe: readonly string[], covered: readonly string[]): HoleList {
  const done = new Set(covered);
  const missing = [...new Set(universe)].filter((item) => !done.has(item));
  return {
    measured: true,
    items: missing.slice(0, MAX_MISSING),
    ...(missing.length > MAX_MISSING ? { overflow: missing.length - MAX_MISSING } : {}),
  };
}

/** The same named list a coverage level reports, so the two can never disagree. */
function fromLevel(ledger: AppLedger, level: CoverageLevel): HoleList {
  const report = levelsOf(ledger).find((l) => l.level === level);
  return {
    measured: true,
    items: report?.missing ?? [],
    ...(report?.missingOverflow === undefined ? {} : { overflow: report.missingOverflow }),
  };
}

export function holesOf(ledger: AppLedger, components?: ComponentInventory): HolesReport {
  const edges = named(ledger.controls.seen, ledger.edges.probed);
  return {
    [HoleKind.ROUTES]: fromLevel(ledger, CoverageLevel.REACHED),
    [HoleKind.CONTROLS]: fromLevel(ledger, CoverageLevel.TOUCHED),
    [HoleKind.EDGES]:
      0 === ledger.edges.probed.length
        ? { ...edges, measured: false, note: HoleNote.EDGES }
        : edges,
    [HoleKind.WRITES]: fromLevel(ledger, CoverageLevel.BRANCHED),
    [HoleKind.FUNCTIONS]:
      0 === Object.keys(ledger.code).length
        ? { measured: false, items: [], note: HoleNote.CODE }
        : fromLevel(ledger, CoverageLevel.EXECUTED),
    [HoleKind.COMPONENTS]:
      components === undefined
        ? { measured: false, items: [], note: HoleNote.COMPONENTS }
        : named(components.known, components.rendered),
  };
}

/** The best percentage each level has reached, raised to today's where today is higher. */
export function raiseBest(ledger: AppLedger): AppLedger {
  const best = { ...ledger.best };
  for (const l of levelsOf(ledger)) {
    if (l.pct !== undefined && l.pct > (best[l.level] ?? -1)) {
      best[l.level] = l.pct;
    }
  }
  return { ...ledger, best };
}

/**
 * Today's levels become the best, so a drop someone decided to accept stops blocking. What was
 * measured stays; only the bar moves, and only when asked (`reticle gate --accept-coverage`).
 */
export function acceptCurrent(ledger: AppLedger): AppLedger {
  const best: Record<string, number> = {};
  for (const l of levelsOf(ledger)) {
    if (l.pct !== undefined) {
      best[l.level] = l.pct;
    }
  }
  return { ...ledger, best };
}

/** Levels now below the best they ever reached — something new appeared and nothing covered it. */
export function regressions(
  ledger: AppLedger,
): { level: CoverageLevel; was: number; now: number }[] {
  const out: { level: CoverageLevel; was: number; now: number }[] = [];
  for (const l of levelsOf(ledger)) {
    const was = ledger.best[l.level];
    if (l.pct !== undefined && was !== undefined && l.pct < was) {
      out.push({ level: l.level, was, now: l.pct });
    }
  }
  return out;
}

/**
 * The ledger's name for a changed file. Matched by path suffix, the same way the flow index matches,
 * so a repo-relative change finds a served `src/...` path.
 */
function servedAs(code: CodeCoverage, file: string): string | undefined {
  return Object.keys(code).find(
    (served) => file === served || file.endsWith(`/${served}`) || served.endsWith(`/${file}`),
  );
}

/** Changed files the browser loaded and never ran a single function of. */
export function unexecutedChanged(code: CodeCoverage, changed: readonly string[]): string[] {
  return changed.filter((file) => {
    const served = servedAs(code, file);
    if (served === undefined) {
      return false;
    }
    const fns = Object.values(code[served] ?? {});
    return fns.length > 0 && fns.every((fn) => !fn.executed);
  });
}

/**
 * Changed files whose coverage was last taken BEFORE they changed. Counts are kept per file across
 * takes, so an edited file still carries the counts of the version before the edit, and "it ran"
 * read from them is about code that no longer exists. A take with no recorded time is as old as
 * any edit. A file with no modification time (deleted) has nothing left to run.
 */
export function staleChanged(
  ledger: AppLedger,
  changed: readonly string[],
  modifiedAt: (file: string) => number | undefined,
): string[] {
  return changed.filter((file) => {
    const served = servedAs(ledger.code, file);
    const modified = modifiedAt(file);
    if (served === undefined || modified === undefined) {
      return false;
    }
    const taken = ledger.codeTaken[served];
    return taken === undefined || modified > taken;
  });
}

/** `.reticle/coverage.json`. Loads never throw: a bad file degrades to an empty ledger. */
export class LedgerStore {
  readonly #fs: FileSystemPort;
  readonly #path: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#path = reticleDirPaths(root).coverage;
  }

  async load(): Promise<AppLedger> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#path);
    } catch (error) {
      if (this.#fs.isNotFound(error)) {
        return emptyLedger();
      }
      throw error;
    }
    return parseLedger(text);
  }

  /**
   * Fold a delta in, raise the best, persist, and hand back the result. Under the file's lock: two
   * sessions folding at once each loaded the same copy, and the later write discarded the other.
   *
   * ponytail: the lock is per daemon process. The CLI's `gate --accept-coverage` in another process
   * can still race a fold; add a lock file if that ever shows up.
   */
  merge(delta: LedgerDelta): Promise<AppLedger> {
    return withFileLock(this.#path, async () =>
      this.#save(raiseBest(mergeLedger(await this.load(), delta))),
    );
  }

  /** Accept today's levels as the best. Returns the drops that were accepted. */
  acceptCurrent(): Promise<ReturnType<typeof regressions>> {
    return withFileLock(this.#path, async () => {
      const ledger = await this.load();
      const accepted = regressions(ledger);
      if (accepted.length > 0) {
        await this.#save(acceptCurrent(ledger));
      }
      return accepted;
    });
  }

  async #save(next: AppLedger): Promise<AppLedger> {
    await this.#fs.mkdir(dirname(this.#path));
    const body = `${JSON.stringify({ version: LEDGER_VERSION, ledger: next })}\n`;
    await writeFileAtomic(this.#fs, this.#path, body);
    return next;
  }
}
