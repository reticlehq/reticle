import { join } from 'node:path';
import { fnv1a } from '@reticlehq/core';
import { writeFileAtomic } from '@/memory/project/fs/write-atomic.js';
import { z } from 'zod';
import { FlowStepSchema, type FlowStep } from '@reticlehq/core';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';

/**
 * Bug capsules. When an assertion fails, the evidence that explains it is in hand exactly once —
 * at the moment of the failure. A capsule persists that moment as a *replayable artifact*: the minimal
 * failing steps, the consequence that was supposed to hold, and the divergence that was observed instead.
 *
 * This is deliberately fail-to-pass shaped (SWE-bench style): a capsule reproduces a bug NOW and, once the
 * fix lands, it is exactly a regression flow. Capsules are ordinary flow files plus evidence, so they
 * replay through the existing machinery rather than needing a second runner.
 */

/**
 * The capsule file-format version. Declared ABOVE the schema so the schema, the writer and this
 * constant cannot disagree about the number.
 */
export const CAPSULE_VERSION = 1;

const CapsuleSchema = z.object({
  version: z.literal(CAPSULE_VERSION),
  id: z.string(),
  /** The flow the failure happened in, when it came from one (a bare assert has no flow). */
  flow: z.string().optional(),
  createdAt: z.number(),
  /** Why it was captured — a failed assertion, a crawl anomaly, a human review pin. */
  origin: z.string(),
  /** The consequence that was supposed to hold. */
  expected: z.string(),
  /** What was observed instead — the first-divergence sentence. */
  observed: z.string(),
  /** Minimal steps to reproduce (prefix-trimmed). */
  steps: z.array(FlowStepSchema),
  /**
   * How many times this exact failure has been captured, and when it last was.
   *
   * A repeat is not a new capsule -- it is the same one, again. "This failed 37 times, most
   * recently at T" is strictly MORE than 37 files each holding one timestamp, so folding the
   * duplicates in adds information rather than discarding it.
   *
   * Optional, because a capsule written before these existed has neither and must not be read as
   * though it were seen once when nobody counted.
   */
  seen: z.number().int().positive().optional(),
  lastSeenAt: z.number().optional(),
});
export type Capsule = z.infer<typeof CapsuleSchema>;

/** Capsule ids are filenames — refuse anything that could escape the capsules directory. */
export function isValidCapsuleId(id: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(id) && id !== '.' && id !== '..' && id.length <= 128;
}

export class CapsuleStore {
  readonly #fs: FileSystemPort;
  readonly #dir: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#dir = reticleDirPaths(root).capsules;
  }

  #pathFor(id: string): string {
    return join(this.#dir, `${id}.json`);
  }

  /** Persist a capsule. Best-effort by design: capturing evidence must never fail the run that found it. */
  async save(capsule: Capsule): Promise<boolean> {
    if (!isValidCapsuleId(capsule.id)) return false;
    try {
      await this.#fs.mkdir(this.#dir);
      /*
       * A capture of a failure already on disk folds into it rather than adding a file. Found by
       * LISTING: the fingerprint is the id's suffix, so this costs one directory read instead of
       * one read per capsule. An id written before fingerprints existed simply never matches, which
       * is the correct outcome -- it is left exactly as it was.
       *
       * `createdAt` keeps the FIRST sighting. A repeat is the same failure happening again, not a
       * new one, and the interesting pair is when it started and when it last happened.
       */
      const fingerprint = capsuleFingerprint(capsule);
      const existingId = (await this.list()).find((id) => id.endsWith(`-${fingerprint}`));
      const previous = existingId === undefined ? undefined : await this.read(existingId);
      const folded: Capsule =
        previous === undefined
          ? { ...capsule, seen: 1, lastSeenAt: capsule.createdAt }
          : {
              ...previous,
              seen: (previous.seen ?? 1) + 1,
              lastSeenAt: capsule.createdAt,
            };
      await writeFileAtomic(
        this.#fs,
        this.#pathFor(folded.id),
        `${JSON.stringify(folded, null, 2)}\n`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Capsule ids on disk, newest-first by id (ids are time-prefixed). Never throws. */
  async list(): Promise<string[]> {
    try {
      if (!(await this.#fs.exists(this.#dir))) return [];
      const entries = await this.#fs.readdir(this.#dir);
      return entries
        .filter((e) => e.endsWith('.json'))
        .map((e) => e.slice(0, -'.json'.length))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Read one capsule; undefined when missing or malformed (never throws). */
  async read(id: string): Promise<Capsule | undefined> {
    if (!isValidCapsuleId(id)) return undefined;
    try {
      const parsed: unknown = JSON.parse(await this.#fs.readFile(this.#pathFor(id)));
      const result = CapsuleSchema.safeParse(parsed);
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every readable capsule, newest-first — what `reticle capsules` prints. */
  async all(): Promise<Capsule[]> {
    const out: Capsule[] = [];
    for (const id of await this.list()) {
      const capsule = await this.read(id);
      if (capsule !== undefined) out.push(capsule);
    }
    return out;
  }
}

/**
 * What makes two captures the SAME failure.
 *
 * Everything that describes the failure, and nothing that describes the capture: `createdAt` is
 * excluded because it is precisely what turned every retry of a broken step into a new file, and
 * `id` because it is derived from this. `flow` is included -- the same assertion failing in two
 * different journeys is two findings, not one.
 */
export function capsuleFingerprint(
  capsule: Omit<Capsule, 'id' | 'createdAt' | 'seen' | 'lastSeenAt'>,
): string {
  return fnv1a(
    JSON.stringify([
      capsule.flow ?? '',
      capsule.origin,
      capsule.expected,
      capsule.observed,
      capsule.steps,
    ]),
  );
}

/**
 * Deterministic, path-safe capsule id: time-ordered so `list` sorts newest-first for free, with the
 * fingerprint on the END so a duplicate can be found by listing the directory rather than reading
 * every file in it.
 */
export function capsuleId(now: number, label: string, fingerprint: string): string {
  const safe = label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
  return `${String(now)}-${safe.length > 0 ? safe : 'capsule'}-${fingerprint}`;
}

/** The minimal reproduction: the steps up to and including the one that failed (prefix trim). */
export function minimalSteps(steps: readonly FlowStep[], failedIndex: number): FlowStep[] {
  if (failedIndex < 0) return [...steps];
  return steps.slice(0, failedIndex + 1);
}
