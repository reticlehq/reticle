import {
  PROJECT_FILE_VERSION,
  PROJECT_ROUTE_CAP,
  PROJECT_RUN_CAP,
  ProjectFileSchema,
  ProjectReadError,
  type ProjectFile,
  type ProjectLearned,
  type RunRecord,
} from '@reticlehq/core';
import type { FileSystemPort } from './fs-port.js';
import type { Clock } from '../flows/flows.js';
import { reticleDirPaths } from './reticle-dir.js';
import { withFileLock } from './file-lock.js';

const JSON_INDENT = 2;

/** Never-throws read result (mirrors ReadContractResult). */
export type ReadProjectResult =
  { ok: true; file: ProjectFile } | { ok: false; reason: ProjectReadError };

const EMPTY_PROJECT: ProjectFile = { version: PROJECT_FILE_VERSION, runs: [] };

/**
 * Cross-run outcome memory persisted at .reticle/project.json. Models FlowStore:
 * injected FileSystemPort + Clock, byte-stable serialize, never-throws read. The clock is the
 * single `at`-stamp site so handlers pass an un-stamped record and no Date.now leaks into logic.
 */
export class ProjectStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #clock: Clock;

  constructor(fs: FileSystemPort, root: string, clock: Clock) {
    this.#fs = fs;
    this.#root = root;
    this.#clock = clock;
  }

  /**
   * Byte-stable serializer: fixed field order (rebuilt literals, never insertion order), 2-space
   * indent + trailing newline. `runs` stays chronological (append order = the data, never sorted);
   * `learned` arrays ARE sorted for diff-stability. Two semantically-equal files → identical bytes.
   */
  #serialize(file: ProjectFile): string {
    const envelope: ProjectFile = {
      version: PROJECT_FILE_VERSION,
      ...(file.learned !== undefined ? { learned: serializeLearned(file.learned) } : {}),
      runs: file.runs.map(serializeRun),
    };
    return `${JSON.stringify(envelope, null, JSON_INDENT)}\n`;
  }

  /** Never throws. Missing → MISSING. Bad JSON / failed schema → MALFORMED. Mirrors readContract. */
  async read(): Promise<ReadProjectResult> {
    const path = reticleDirPaths(this.#root).project;
    if (!(await this.#fs.exists(path))) return { ok: false, reason: ProjectReadError.MISSING };

    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      return {
        ok: false,
        reason: this.#fs.isNotFound(error) ? ProjectReadError.MISSING : ProjectReadError.MALFORMED,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: ProjectReadError.MALFORMED };
    }

    const result = ProjectFileSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: ProjectReadError.MALFORMED };
    return { ok: true, file: result.data };
  }

  /**
   * Append a run, stamping `at` from the injected clock (the one clock site). A MISSING **or
   * MALFORMED** existing file self-heals to a fresh empty file so corrupt history never blocks
   * recording — unlike the read path, which surfaces MALFORMED honestly. Truncates per policy
   * (last PER_NAME of any one name, then cap to TOTAL overall) and writes byte-stably.
   */
  async recordRun(record: Omit<RunRecord, 'at'>): Promise<void> {
    const path = reticleDirPaths(this.#root).project;
    // Serialized per file: a parallel flow_verify records N runs concurrently, and an unlocked
    // read-append-write drops every run but the last writer's (each read the same base list).
    await withFileLock(path, async () => {
      const existing = await this.read();
      const base: ProjectFile = existing.ok ? existing.file : EMPTY_PROJECT;
      const stamped: RunRecord = { ...record, at: this.#clock.now() };
      const runs = truncate([...base.runs, stamped]);
      const next: ProjectFile = { ...base, runs };
      await this.#fs.mkdir(reticleDirPaths(this.#root).root);
      await this.#fs.writeFile(path, this.#serialize(next));
    });
  }

  /**
   * Add discovered routes to the learned app map. Empty input is a no-op so "nothing observed"
   * does not materialize as `learned.routes: []`; non-empty updates are serialized per file so
   * concurrent browser sessions accumulate rather than overwriting one another.
   */
  async recordRoutes(routes: readonly string[]): Promise<void> {
    const additions = routes.filter((route) => route.length > 0);
    if (0 === additions.length) return;

    const path = reticleDirPaths(this.#root).project;
    await withFileLock(path, async () => {
      const existing = await this.read();
      const base: ProjectFile = existing.ok ? existing.file : EMPTY_PROJECT;
      const current = base.learned?.routes ?? [];
      const merged = [...new Set([...current, ...additions])].slice(0, PROJECT_ROUTE_CAP);
      if (
        merged.length === current.length &&
        merged.every((route, index) => route === current[index])
      )
        return;
      const learned: ProjectLearned = { ...base.learned, routes: merged };
      const next: ProjectFile = { ...base, learned };
      await this.#fs.mkdir(reticleDirPaths(this.#root).root);
      await this.#fs.writeFile(path, this.#serialize(next));
    });
  }

  /**
   * The best observability this project has reached, and the raiser of that bar.
   *
   * Read returns undefined on a first run or an unreadable file, which is the honest "no best to
   * fall from" — never a zero, which would make every first run look like a recovery.
   */
  async bestObservability(): Promise<{ percent: number } | undefined> {
    const existing = await this.read();
    return existing.ok ? existing.file.learned?.bestObservability : undefined;
  }

  /**
   * Raise the bar, if this run cleared it. Lowering is deliberately impossible.
   *
   * A best that could fall would let a weakened run quietly redefine what good looks like, which is
   * precisely the gaming the figure exists to resist. Serialized per file so two sessions racing
   * cannot lose the higher of the two.
   */
  async raiseObservability(percent: number): Promise<void> {
    const path = reticleDirPaths(this.#root).project;
    await withFileLock(path, async () => {
      const existing = await this.read();
      const base: ProjectFile = existing.ok ? existing.file : EMPTY_PROJECT;
      const current = base.learned?.bestObservability?.percent;
      if (current !== undefined && percent <= current) return;
      const learned: ProjectLearned = {
        ...base.learned,
        bestObservability: { percent, at: this.#clock.now() },
      };
      await this.#fs.mkdir(reticleDirPaths(this.#root).root);
      await this.#fs.writeFile(path, this.#serialize({ ...base, learned }));
    });
  }

  /** The most-recent run for `name` (undefined on missing/malformed/none). Powers diff-vs-last. */
  async lastRun(name: string): Promise<RunRecord | undefined> {
    const read = await this.read();
    if (!read.ok) return undefined;
    for (let i = read.file.runs.length - 1; i >= 0; i -= 1) {
      const run = read.file.runs[i];
      if (run !== undefined && run.name === name) return run;
    }
    return undefined;
  }
}

/** Field-ordered rebuild of one run record so serialization is byte-stable. */
function serializeRun(run: RunRecord): RunRecord {
  return {
    kind: run.kind,
    name: run.name,
    status: run.status,
    at: run.at,
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
    ...(run.evidence !== undefined ? { evidence: run.evidence } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
  };
}

/** Sorted, field-ordered rebuild of the learned map for diff-stability. */
function serializeLearned(learned: ProjectLearned): ProjectLearned {
  return {
    ...(learned.flows !== undefined ? { flows: [...learned.flows].sort() } : {}),
    ...(learned.routes !== undefined ? { routes: [...learned.routes].sort() } : {}),
  };
}

/**
 * Cap project memory while GUARANTEEING each flow keeps its last-known-good. Pass 1 reserves the
 * most-recent run of every distinct name (never evicted by the TOTAL cap), so a fresh session can always
 * answer "did my last run of this flow pass?" locally — the durable, free regression memory the solo
 * loop needs. Pass 2 fills the remaining budget with additional recent runs (PER_NAME per name, TOTAL
 * overall). Chronological order (oldest→newest) is preserved.
 */
function truncate(runs: RunRecord[]): RunRecord[] {
  const perName = new Map<string, number>();
  const kept = new Set<number>();
  // Pass 1 (newest→oldest): reserve each name's latest run. Kept regardless of the TOTAL cap.
  const seen = new Set<string>();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run === undefined || seen.has(run.name)) continue;
    seen.add(run.name);
    kept.add(i);
    perName.set(run.name, 1);
  }
  // Pass 2 (newest→oldest): fill the rest with extra recent runs, respecting PER_NAME and TOTAL.
  for (let i = runs.length - 1; i >= 0 && kept.size < PROJECT_RUN_CAP.TOTAL; i -= 1) {
    const run = runs[i];
    if (run === undefined || kept.has(i)) continue;
    const count = perName.get(run.name) ?? 0;
    if (count >= PROJECT_RUN_CAP.PER_NAME) continue;
    perName.set(run.name, count + 1);
    kept.add(i);
  }
  return runs.filter((_, i) => kept.has(i));
}
