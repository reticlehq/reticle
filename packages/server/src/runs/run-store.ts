/**
 * Persistence for verification-run artifacts at .iris/runs/<runId>.json. Mirrors ProjectStore:
 * injected FileSystemPort, never-throws read, path-segment guard on the runId (the tool-arg attack
 * surface). One artifact per file (unlike project.json's single rolling file) so a host can attach an
 * individual run to a deploy. The run is already clock-stamped by buildVerificationRun, so the store
 * needs no clock.
 */

import {
  IrisVerificationRunSchema,
  RunReadError,
  type IrisVerificationRun,
} from '@syrin/iris-protocol';
import type { FileSystemPort } from '../project/fs-port.js';
import { irisDirPaths, isValidRunId, runPath } from '../project/iris-dir.js';

const JSON_INDENT = 2;
const JSON_EXT = '.json';

/** Never-throws read result (mirrors ReadProjectResult). */
export type ReadRunResult =
  | { ok: true; run: IrisVerificationRun }
  | { ok: false; reason: RunReadError };

export class RunStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#root = root;
  }

  /** Write one run artifact. Creates .iris/runs/ first; byte-stable (fixed indent + trailing newline). */
  async write(run: IrisVerificationRun): Promise<void> {
    await this.#fs.mkdir(irisDirPaths(this.#root).runs);
    await this.#fs.writeFile(
      runPath(this.#root, run.runId),
      `${JSON.stringify(run, null, JSON_INDENT)}\n`,
    );
  }

  /** Never throws. Invalid id / missing → MISSING; bad JSON or failed schema → MALFORMED. */
  async read(runId: string): Promise<ReadRunResult> {
    if (!isValidRunId(runId)) return { ok: false, reason: RunReadError.MISSING };
    const path = runPath(this.#root, runId);
    if (!(await this.#fs.exists(path))) return { ok: false, reason: RunReadError.MISSING };

    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      return {
        ok: false,
        reason: this.#fs.isNotFound(error) ? RunReadError.MISSING : RunReadError.MALFORMED,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: RunReadError.MALFORMED };
    }

    const result = IrisVerificationRunSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: RunReadError.MALFORMED };
    return { ok: true, run: result.data };
  }

  /** List run ids on disk (filenames minus .json). Empty when the runs dir is absent. */
  async list(): Promise<string[]> {
    const dir = irisDirPaths(this.#root).runs;
    if (!(await this.#fs.exists(dir))) return [];
    let entries: string[];
    try {
      entries = await this.#fs.readdir(dir);
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith(JSON_EXT)).map((e) => e.slice(0, -JSON_EXT.length));
  }

  /** The most-recent run by createdAt (undefined when none). Powers iris_run_export's default. */
  async latest(): Promise<IrisVerificationRun | undefined> {
    const ids = await this.list();
    let best: IrisVerificationRun | undefined;
    for (const id of ids) {
      const result = await this.read(id);
      if (result.ok && (best === undefined || result.run.createdAt > best.createdAt)) {
        best = result.run;
      }
    }
    return best;
  }
}
