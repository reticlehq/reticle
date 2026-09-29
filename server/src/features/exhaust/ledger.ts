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

import { dirname } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '@/memory/project/fs/write-atomic.js';
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
const MAX_MISSING = 50;

const names = z.array(z.string());
const LedgerSchema = z.object({
  routes: z.object({ discovered: names, reached: names }),
  controls: z.object({ seen: names, touched: names, proved: names }),
  journeys: z.object({ completed: names }),
  writes: z.object({ seen: names, branched: names, unhandled: names }),
  code: z.record(z.record(z.object({ name: z.string(), executed: z.boolean() }))),
  best: z.record(z.number()),
});
export type AppLedger = z.infer<typeof LedgerSchema>;

/** What one producer contributes. Every part optional: a drive adds what it saw and nothing else. */
export interface LedgerDelta {
  routes?: Partial<AppLedger['routes']>;
  controls?: Partial<AppLedger['controls']>;
  journeys?: Partial<AppLedger['journeys']>;
  writes?: Partial<AppLedger['writes']>;
  code?: CodeCoverage;
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

export function emptyLedger(): AppLedger {
  return {
    routes: { discovered: [], reached: [] },
    controls: { seen: [], touched: [], proved: [] },
    journeys: { completed: [] },
    writes: { seen: [], branched: [], unhandled: [] },
    code: {},
    best: {},
  };
}

const union = (a: readonly string[], b: readonly string[] | undefined): string[] =>
  b === undefined ? [...a] : [...new Set([...a, ...b])];

export function mergeLedger(into: AppLedger, delta: LedgerDelta): AppLedger {
  const code: CodeCoverage = { ...into.code };
  for (const [file, fns] of Object.entries(delta.code ?? {})) {
    const merged = { ...(code[file] ?? {}) };
    for (const [key, fn] of Object.entries(fns)) {
      merged[key] = { name: fn.name, executed: fn.executed || true === merged[key]?.executed };
    }
    code[file] = merged;
  }
  // Reaching a route discovers it; touching or proving a control means it was seen.
  const reached = union(into.routes.reached, delta.routes?.reached);
  const touched = union(into.controls.touched, delta.controls?.touched);
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
    code,
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

/** The best percentage each level has reached, raised to today's where today is higher. */
export function raiseBest(ledger: AppLedger): AppLedger {
  const best = { ...ledger.best };
  for (const l of levelsOf(ledger)) {
    if (l.pct !== undefined && l.pct > (best[l.level] ?? -1)) best[l.level] = l.pct;
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
    if (l.pct !== undefined && was !== undefined && l.pct < was)
      out.push({ level: l.level, was, now: l.pct });
  }
  return out;
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
      if (this.#fs.isNotFound(error)) return emptyLedger();
      throw error;
    }
    try {
      const parsed = z
        .object({ version: z.literal(LEDGER_VERSION), ledger: LedgerSchema })
        .safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.ledger : emptyLedger();
    } catch {
      return emptyLedger();
    }
  }

  /** Fold a delta in, raise the best, persist, and hand back the result. */
  async merge(delta: LedgerDelta): Promise<AppLedger> {
    const next = raiseBest(mergeLedger(await this.load(), delta));
    await this.#fs.mkdir(dirname(this.#path));
    const body = `${JSON.stringify({ version: LEDGER_VERSION, ledger: next })}\n`;
    await writeFileAtomic(this.#fs, this.#path, body);
    return next;
  }
}
