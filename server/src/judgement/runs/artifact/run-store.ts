/**
 * Persistence for verification-run artifacts at .reticle/runs/<runId>.json. Mirrors ProjectStore:
 * injected FileSystemPort, never-throws read, path-segment guard on the runId (the tool-arg attack
 * surface). One artifact per file (unlike project.json's single rolling file) so a host can attach an
 * individual run to a deploy. The run is already clock-stamped by buildVerificationRun, so the store
 * needs no clock.
 */

import {
  asRunId,
  ReticleVerificationRunSchema,
  RUN_RETENTION,
  RUN_RETENTION_SLACK,
  RunReadError,
  RunScreenshotSchema,
  STEP_SCREENSHOT,
  type ReticleVerificationRun,
  type RunId,
  type RunScreenshot,
  type StepScreenshot,
} from '@reticlehq/core';
import { PromptContextSchema, type PromptContext } from '@reticlehq/core/artifacts';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  reticleDirPaths,
  isValidRunId,
  runPath,
  stepShotDir,
} from '@/memory/project/dir/reticle-dir.js';
import { join } from 'node:path';

const JSON_INDENT = 2;
const JSON_EXT = '.json';
const TMP_EXT = '.tmp';

/** Never-throws read result (mirrors ReadProjectResult). */
export type ReadRunResult =
  { ok: true; run: ReticleVerificationRun } | { ok: false; reason: RunReadError };

/** Optional retention overrides (defaults to the protocol caps). Injectable so tests prune fast. */
interface RunStoreOptions {
  retention?: number;
  slack?: number;
  /**
   * Called after a run artifact is safely on disk. Used to wake cloud sync so a finished
   * verification reaches the dashboard promptly instead of waiting for the next timer tick.
   *
   * A callback rather than a dependency on the sync daemon: the store's job is durability, and a
   * store that imported the cloud would make "write a run" fail whenever the cloud did. It is
   * invoked AFTER the rename, so nothing can observe a run that is not yet readable, and it must
   * never throw — see the call site.
   */
  onWrote?: () => void;
}

/** A request older than this is about some other task, not the run being written now. */
const REQUEST_RELEVANT_MS = 6 * 60 * 60 * 1000;

/** Which run a recorded request was attached to, written into the request file. */
const REQUEST_RUN_KEY = 'answeredByRun';

export class RunStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #retention: number;
  readonly #slack: number;
  readonly #onWrote: (() => void) | undefined;

  constructor(fs: FileSystemPort, root: string, opts: RunStoreOptions = {}) {
    this.#fs = fs;
    this.#root = root;
    this.#retention = opts.retention ?? RUN_RETENTION;
    this.#slack = opts.slack ?? RUN_RETENTION_SLACK;
    this.#onWrote = opts.onWrote;
  }

  /**
   * Write one run artifact. Creates .reticle/runs/ first; byte-stable (fixed indent + trailing newline).
   * Guards runId as a safe path segment BEFORE building the path — a runId can originate from a caller
   * (an OEM may set it), so an unsafe value must never escape .reticle/runs/ (mirrors the read guard).
   */
  async write(given: ReticleVerificationRun): Promise<void> {
    let run = given;
    if (!isValidRunId(run.runId)) {
      throw new Error(`refusing to write run with unsafe runId: ${JSON.stringify(run.runId)}`);
    }
    await this.#fs.mkdir(reticleDirPaths(this.#root).runs);
    const context = run.context ?? (await this.#recentRequest(run.createdAt, run.runId));
    if (context !== undefined) run = { ...run, context };
    // The step screenshots taken for this run, the last of which may still be landing.
    await shotsLanded(this.#root, run.runId);
    run = withScreenshots(run, await readStepShots(this.#fs, this.#root, run.runId));
    // Atomic publish: write a temp file then rename, so a crash mid-write never leaves a half-written
    // artifact (a partial.json would otherwise read back as MALFORMED).
    const path = runPath(this.#root, run.runId);
    const tmp = `${path}${TMP_EXT}`;
    await this.#fs.writeFile(tmp, `${JSON.stringify(run, null, JSON_INDENT)}\n`);
    await this.#fs.rename(tmp, path);
    // AFTER the rename: a listener that reads the run back must find it there. Swallowed, because
    // this is a notification — a sync that cannot be woken must never fail the write it followed.
    try {
      this.#onWrote?.();
    } catch {
      // Not this store's problem, and not worth failing a durable write over.
    }
    await this.#pruneOld();
  }

  /**
   * The user's request this run answers, when the agent relayed one recently enough to be about it.
   * Read from .reticle/intent/request.json (written by `reticle_intent { declare, request }`).
   */
  async #recentRequest(at: number, runId: string): Promise<PromptContext | undefined> {
    try {
      const path = reticleDirPaths(this.#root).request;
      const raw = JSON.parse(await this.#fs.readFile(path)) as Record<string, unknown>;
      const parsed = PromptContextSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      const given = parsed.data.at;
      if (given === undefined || at - given < 0 || REQUEST_RELEVANT_MS < at - given)
        return undefined;
      // The first run written for a request answers it; a later run (the next agent session in the
      // same tab) inherited it and showed a goal it never had. Its own rewrite keeps it.
      const answeredBy = raw[REQUEST_RUN_KEY];
      if ('string' === typeof answeredBy) return answeredBy === runId ? parsed.data : undefined;
      await this.#fs.writeFile(
        path,
        `${JSON.stringify({ ...raw, [REQUEST_RUN_KEY]: runId }, null, JSON_INDENT)}\n`,
      );
      return parsed.data;
    } catch {
      return undefined; // no request recorded: the common case
    }
  }

  /**
   * Keep .reticle/runs/ bounded. Only acts once the count exceeds RUN_RETENTION + SLACK, then deletes the
   * oldest (by createdAt) back down to RUN_RETENTION — so the read-all is amortized, not per-write.
   */
  async #pruneOld(): Promise<void> {
    const ids = await this.list();
    if (ids.length <= this.#retention + this.#slack) return;
    // `id: RunId`, not `string`. `list()` already returns RunId[]; annotating the local as string
    // silently discarded the brand and handed a bare string to runPath — which is the transposition
    // the brand exists to prevent, reintroduced by a type annotation rather than by a bad call.
    const stamped: Array<{ id: RunId; at: number }> = [];
    for (const id of ids) {
      const result = await this.read(id);
      stamped.push({ id, at: result.ok ? result.run.createdAt : 0 });
    }
    stamped.sort((a, b) => a.at - b.at);
    for (const { id } of stamped.slice(0, stamped.length - this.#retention)) {
      await this.#fs.rm(runPath(this.#root, id));
    }
  }

  /** Never throws. Invalid id / missing → MISSING; bad JSON or failed schema → MALFORMED. */
  async read(runId: RunId): Promise<ReadRunResult> {
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

    const result = ReticleVerificationRunSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: RunReadError.MALFORMED };
    return { ok: true, run: result.data };
  }

  /** List run ids on disk (filenames minus.json). Empty when the runs dir is absent. */
  async list(): Promise<RunId[]> {
    const dir = reticleDirPaths(this.#root).runs;
    if (!(await this.#fs.exists(dir))) return [];
    let entries: string[];
    try {
      entries = await this.#fs.readdir(dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.endsWith(JSON_EXT))
      .map((e) => asRunId(e.slice(0, -JSON_EXT.length)));
  }

  /** The most-recent run by createdAt (undefined when none). Powers reticle_run_export's default. */
  async latest(): Promise<ReticleVerificationRun | undefined> {
    const ids = await this.list();
    let best: ReticleVerificationRun | undefined;
    for (const id of ids) {
      const result = await this.read(id);
      if (result.ok && (best === undefined || result.run.createdAt > best.createdAt)) {
        best = result.run;
      }
    }
    return best;
  }

  /**
   * The two most-recent runs by createdAt as `[previous, current]` (oldest-first), or undefined when
   * fewer than two readable runs exist. Powers reticle_run_export's `format:"diff"` (run-to-run deltas).
   */
  async latestTwo(): Promise<[ReticleVerificationRun, ReticleVerificationRun] | undefined> {
    const runs: ReticleVerificationRun[] = [];
    for (const id of await this.list()) {
      const result = await this.read(id);
      if (result.ok) runs.push(result.run);
    }
    if (runs.length < 2) return undefined;
    runs.sort((a, b) => a.createdAt - b.createdAt);
    const previous = runs[runs.length - 2];
    const current = runs[runs.length - 1];
    if (previous === undefined || current === undefined) return undefined;
    return [previous, current];
  }
}

/*
 * A run's step screenshots, as its artifact records them. The images are written beside the run
 * (`.reticle/visual/runs/<runId>/`) with one record line each in `shots.jsonl` by
 * `features/visual/step-shots.ts`; this is the reading half.
 */

/** How long a run write waits for screenshots still landing. A capture is never worth a stuck run. */
const LANDING_WAIT_MS = 10_000;

/** Captures still landing, per run directory. */
const landing = new Map<string, Set<Promise<void>>>();

/** Remember a capture that has not landed yet, so a run written now can wait for it. */
export function noteLanding(dir: string, land: Promise<void>): void {
  const pending = landing.get(dir) ?? new Set<Promise<void>>();
  landing.set(dir, pending);
  pending.add(land);
  void land.finally(() => pending.delete(land));
}

/** Wait for this run's screenshots still landing, so a run written now can list them. Bounded. */
export async function shotsLanded(root: string, runId: string): Promise<void> {
  if (!isValidRunId(runId)) return;
  const pending = landing.get(stepShotDir(root, runId));
  if (pending === undefined || 0 === pending.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LANDING_WAIT_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/** One line of a run's record, read back; anything malformed is skipped. */
function parseLine(line: string): RunScreenshot | undefined {
  try {
    const parsed = RunScreenshotSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every screenshot a run has landed, in the order they were taken (by seq). Never throws. */
export async function readStepShots(
  fs: FileSystemPort,
  root: string,
  runId: string,
): Promise<RunScreenshot[]> {
  if (!isValidRunId(runId)) return [];
  try {
    const text = await fs.readFile(join(stepShotDir(root, runId), STEP_SCREENSHOT.MANIFEST_FILE));
    return (
      text
        .split('\n')
        .filter((line) => line.length > 0)
        .map(parseLine)
        .filter((shot): shot is RunScreenshot => shot !== undefined)
        // In the order they were TAKEN: captures land in whatever order they finish.
        .sort((a, b) => a.seq - b.seq)
    );
  } catch {
    return [];
  }
}

/** The four facts a step records about its picture, out of the run-wide entry. */
function stepShotOf(shot: RunScreenshot): StepScreenshot {
  const { file, source, width, height, sha256 } = shot;
  return { file, source, width, height, sha256 };
}

/** An id that occurs once in the list; a repeated one (a reload restarts the count) pairs nothing. */
function uniqueIds(ids: readonly (string | undefined)[]): Set<string> {
  const seen = new Map<string, number>();
  for (const id of ids) if (id !== undefined) seen.set(id, (seen.get(id) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => 1 === n).map(([id]) => id));
}

/**
 * Pair by the journal action each was taken for, when both sides name it. A check that took no
 * picture (a `steps` call, an answer refused as an error) then costs only its own picture, where the
 * ordinal pairing below lost every picture in the run.
 */
function pairByAction(
  run: ReticleVerificationRun,
  shots: readonly RunScreenshot[],
): { checks: ReticleVerificationRun['checks']; shots: RunScreenshot[] } | undefined {
  const verdictShots = shots.filter((shot) => true === shot.verdict && shot.actionId !== undefined);
  if (0 === verdictShots.length || run.checks.every((check) => check.actionId === undefined))
    return undefined;
  const okChecks = uniqueIds(run.checks.map((check) => check.actionId));
  const okShots = uniqueIds(verdictShots.map((shot) => shot.actionId));
  const shotOf = new Map(
    verdictShots.flatMap((shot) =>
      shot.actionId !== undefined && okShots.has(shot.actionId) && okChecks.has(shot.actionId)
        ? [[shot.actionId, shot] as const]
        : [],
    ),
  );
  const checkIdOf = new Map<RunScreenshot, string>();
  const checks = run.checks.map((check) => {
    const shot = check.actionId === undefined ? undefined : shotOf.get(check.actionId);
    if (shot === undefined) return check;
    if (check.checkId !== undefined) checkIdOf.set(shot, check.checkId);
    return { ...check, screenshot: stepShotOf(shot) };
  });
  return {
    checks,
    shots: shots.map((shot) => {
      const checkId = checkIdOf.get(shot);
      return checkId === undefined ? shot : { ...shot, checkId };
    }),
  };
}

/**
 * Pair each verdict's picture with the check it produced: the n-th verdict picture is the n-th check,
 * because both are written in the order the verdicts were given. Only when the counts agree — a
 * verdict this run did not fold, or one taken while the capture failed, would shift every pairing
 * after it, and an unpaired picture is better than one shown beside the wrong check.
 */
function pairWithChecks(
  run: ReticleVerificationRun,
  shots: readonly RunScreenshot[],
): { checks: ReticleVerificationRun['checks']; shots: RunScreenshot[] } {
  const byAction = pairByAction(run, shots);
  if (byAction !== undefined) return byAction;
  const verdictShots = shots.filter((shot) => true === shot.verdict);
  if (
    0 === verdictShots.length ||
    verdictShots.length !== run.checks.length ||
    run.checks.some((check) => check.checkId === undefined)
  )
    return { checks: run.checks, shots: [...shots] };
  const checkIdOf = new Map(verdictShots.map((shot, i) => [shot, run.checks[i]?.checkId]));
  return {
    checks: run.checks.map((check, i) => {
      const shot = verdictShots[i];
      return shot === undefined ? check : { ...check, screenshot: stepShotOf(shot) };
    }),
    shots: shots.map((shot) => {
      const checkId = checkIdOf.get(shot);
      return checkId === undefined ? shot : { ...shot, checkId };
    }),
  };
}

/**
 * The run with its screenshots: every one in `screenshots`, each replayed step's pinned to that
 * step (matched as `<flow>#<step>`), and each verdict's to its check. Pure. A run with none comes
 * back unchanged.
 */
export function withScreenshots(
  run: ReticleVerificationRun,
  taken: readonly RunScreenshot[],
): ReticleVerificationRun {
  if (0 === taken.length) return run;
  const { checks, shots } = pairWithChecks(run, taken);
  const byStep = new Map(
    shots.flatMap((shot) => (shot.step === undefined ? [] : [[shot.step, shot] as const])),
  );
  const flows = run.flows.map((flow) =>
    flow.stepResults === undefined
      ? flow
      : {
          ...flow,
          stepResults: flow.stepResults.map((result) => {
            const shot = byStep.get(`${flow.name}#${String(result.step)}`);
            return shot === undefined ? result : { ...result, screenshot: stepShotOf(shot) };
          }),
        },
  );
  return { ...run, checks, flows, screenshots: shots };
}
