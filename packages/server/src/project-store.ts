import {
  PROJECT_FILE_VERSION,
  PROJECT_RUN_CAP,
  ProjectFileSchema,
  ProjectReadError,
  type ProjectFile,
  type ProjectLearned,
  type RunRecord,
} from '@syrin/iris-protocol';
import type { FileSystemPort } from './fs-port.js';
import type { Clock } from './flows.js';
import { irisDirPaths } from './iris-dir.js';

const JSON_INDENT = 2;

/** Never-throws read result (mirrors ReadContractResult). */
export type ReadProjectResult =
  | { ok: true; file: ProjectFile }
  | { ok: false; reason: ProjectReadError };

const EMPTY_PROJECT: ProjectFile = { version: PROJECT_FILE_VERSION, runs: [] };

/**
 * 0.3.7 RUNHISTORY — cross-run outcome memory persisted at .iris/project.json. Models FlowStore:
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
    const path = irisDirPaths(this.#root).project;
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
    const existing = await this.read();
    const base: ProjectFile = existing.ok ? existing.file : EMPTY_PROJECT;
    const stamped: RunRecord = { ...record, at: this.#clock.now() };
    const runs = truncate([...base.runs, stamped]);
    const next: ProjectFile = { ...base, runs };
    await this.#fs.mkdir(irisDirPaths(this.#root).root);
    await this.#fs.writeFile(irisDirPaths(this.#root).project, this.#serialize(next));
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
 * Keep at most PER_NAME most-recent runs of any single name, then cap the whole list to TOTAL
 * most-recent overall. Chronological order (oldest→newest) is preserved throughout.
 */
function truncate(runs: RunRecord[]): RunRecord[] {
  const perName = new Map<string, number>();
  const keptReversed: RunRecord[] = [];
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run === undefined) continue;
    const count = perName.get(run.name) ?? 0;
    if (count >= PROJECT_RUN_CAP.PER_NAME) continue;
    perName.set(run.name, count + 1);
    keptReversed.push(run);
    if (keptReversed.length >= PROJECT_RUN_CAP.TOTAL) break;
  }
  return keptReversed.reverse();
}
