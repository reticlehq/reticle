/**
 * What the agent is told about the Reticle platform, and when. One channel, two audiences.
 *
 * A machine that is NOT linked hears about the platform at real moments only, each once per project
 * and never as an ad: verified runs that exist only here, a flow whose failure history nobody else
 * can see, and a `.reticle` that has grown large. Each is a fact about the user's own work, with the
 * one command that changes it.
 *
 * A machine that IS linked hears where its work stands: once when the platform first confirms it,
 * then only when that changes (the platform refused a run, a push failed, or it recovered). Silence
 * means it is going up. The daemon pushes after every run; an agent can force one with
 * `reticle_project { push }`.
 *
 * Remembered in `.reticle`, so a restarted daemon does not repeat itself. Never throws, never blocks
 * a verdict, and an embedder with no link port hears nothing.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleDir, Verified } from '@reticlehq/core';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { FlakeFileSchema } from '@/language/flows/recording/flake.js';
import {
  SyncStatus,
  describeSync,
  overallStatus,
  readSyncSummary,
} from '@/memory/project/sync-status.js';
import type { ToolDeps } from './tool-kit.js';

/** Verified runs kept only on this machine before the platform is worth a sentence. */
export const LOCAL_RUNS_MOMENT = 5;
/** A `.reticle` this large is history worth keeping somewhere other than one laptop. */
export const LARGE_RETICLE_BYTES = 50 * 1024 * 1024;
/** A flow that has failed this often has a history worth sharing. */
const FLAKY_MIN_RUNS = 3;
/** How often the linked status is re-read: it reads every run, so not on every verdict. */
const STATUS_EVERY_MS = 10_000;
/** How many verdicts between size checks: walking `.reticle` is not free either. */
const SIZE_EVERY = 20;
const MOMENTS_FILE = ReticleDir.PLATFORM_MOMENTS_FILE;
const CONNECT = '`npx @reticlehq/server connect`';
const RUN_FILE = /\.json$/;

const Moment = {
  LOCAL_RUNS: 'local-runs',
  FLAKE: 'flake-history',
  LARGE: 'large-reticle',
} as const;

interface Told {
  moments: string[];
  /** The last linked status said to the agent, so only a change is said again. */
  status?: string;
}

interface Seen {
  told: Told;
  statusAt: number;
  verdicts: number;
}

/** Per root, in this process: what is known, so the file is read once and checks are throttled. */
const seen = new Map<string, Seen>();

export async function takePlatformMoment(
  deps: Pick<ToolDeps, 'fs' | 'linkedCloud'> & { now?: () => number },
  raw: Record<string, unknown>,
  /** The `.reticle` of the project the verdict was about — the session's, not the daemon's. */
  rootOf: () => string,
): Promise<string | undefined> {
  if (!('verified' in raw) || deps.linkedCloud === undefined) return undefined;
  try {
    const root = rootOf();
    const now = (deps.now ?? Date.now)();
    const entry = seen.get(root) ?? { told: await readTold(deps, root), statusAt: 0, verdicts: 0 };
    seen.set(root, entry);
    entry.verdicts += 1;
    const linked = (await deps.linkedCloud()) !== null;
    const note = linked
      ? linkedNote(root, entry, now)
      : Verified.YES === raw['verified']
        ? await unlinkedNote(deps, root, entry)
        : undefined;
    if (note !== undefined) await writeTold(deps, root, entry.told);
    return note;
  } catch {
    return undefined; // a note never costs a tool call anything
  }
}

/** Where a linked project's work stands, said only when that changed. */
function linkedNote(root: string, entry: Seen, now: number): string | undefined {
  if (0 !== entry.statusAt && now - entry.statusAt < STATUS_EVERY_MS) return undefined;
  entry.statusAt = now;
  const summary = readSyncSummary(root, true);
  if (0 === summary.runs) return undefined;
  const status = overallStatus(summary);
  // The key is what would change the sentence's meaning, not its numbers: a count going up is the
  // sync working, and saying so on every verdict would be noise.
  const key = [status, ...summary.refused.map((r) => r.runId), summary.lastError ?? ''].join('|');
  if (key === entry.told.status) return undefined;
  const first = entry.told.status === undefined;
  const wasTrouble = !first && !(entry.told.status ?? '').startsWith(SyncStatus.ON_PLATFORM);
  entry.told.status = key;
  // A backlog the next push will clear is not news unless something went wrong with it.
  if (status === SyncStatus.PENDING && summary.lastError === undefined) return undefined;
  if (status === SyncStatus.ON_PLATFORM && !first && !wasTrouble) return undefined;
  const lead =
    status === SyncStatus.ON_PLATFORM
      ? first
        ? 'Verified runs reach the Reticle platform automatically after each verdict: '
        : 'Sync to the Reticle platform recovered: '
      : 'Sync to the Reticle platform needs attention: ';
  return (
    `${lead}${describeSync(summary, now)} The daemon pushes on its own; there is nothing for you ` +
    'to run. Tell the user in one line only if this needs them.'
  );
}

/** The first real moment this project has reached and not yet been told about. */
async function unlinkedNote(
  deps: Pick<ToolDeps, 'fs'>,
  root: string,
  entry: Seen,
): Promise<string | undefined> {
  const told = new Set(entry.told.moments);
  const say = (moment: string, text: string): string => {
    entry.told.moments = [...told, moment];
    return `${text} ${CONNECT} keeps it on the Reticle platform. Mention it to the user once, in one line, after your answer; do not repeat it.`;
  };
  if (!told.has(Moment.LOCAL_RUNS)) {
    const runs = (await deps.fs.readdir(reticleDirPaths(root).runs)).filter((f) =>
      RUN_FILE.test(f),
    );
    if (runs.length >= LOCAL_RUNS_MOMENT)
      return say(
        Moment.LOCAL_RUNS,
        `${String(runs.length)} verified runs of this project exist only on this machine: a teammate cannot replay them and no dashboard tracks them.`,
      );
  }
  if (!told.has(Moment.FLAKE)) {
    const flaky = await flakyFlow(deps, root);
    if (flaky !== undefined)
      return say(
        Moment.FLAKE,
        `The flow "${flaky.name}" has failed ${String(flaky.fails)} of ${String(flaky.runs)} runs here, and that history lives only on this machine, so nobody else can see it is unreliable.`,
      );
  }
  if (!told.has(Moment.LARGE) && 0 === entry.verdicts % SIZE_EVERY) {
    const bytes = sizeOf(root);
    if (bytes >= LARGE_RETICLE_BYTES)
      return say(
        Moment.LARGE,
        `This project's .reticle holds ${String(Math.round(bytes / (1024 * 1024)))} MB of verification history on this machine alone.`,
      );
  }
  return undefined;
}

async function flakyFlow(
  deps: Pick<ToolDeps, 'fs'>,
  root: string,
): Promise<{ name: string; runs: number; fails: number } | undefined> {
  try {
    const parsed = FlakeFileSchema.safeParse(
      JSON.parse(await deps.fs.readFile(reticleDirPaths(root).flake)),
    );
    if (!parsed.success) return undefined;
    const found = Object.entries(parsed.data.flows).find(
      ([, f]) => f.runs >= FLAKY_MIN_RUNS && 0 < f.fails && f.fails < f.runs,
    );
    return found === undefined
      ? undefined
      : { name: found[0], runs: found[1].runs, fails: found[1].fails };
  } catch {
    return undefined;
  }
}

/** Bytes under a directory. ponytail: a full walk, sampled every SIZE_EVERY verdicts. */
function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(path) : statSync(path).size;
  }
  return total;
}

async function readTold(deps: Pick<ToolDeps, 'fs'>, root: string): Promise<Told> {
  try {
    const raw: unknown = JSON.parse(await deps.fs.readFile(join(root, MOMENTS_FILE)));
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((m): m is string => 'string' === typeof m) : [];
    // The first version of this file was a bare list of moments.
    if (Array.isArray(raw)) return { moments: strings(raw) };
    const r = raw as { moments?: unknown; status?: unknown };
    return {
      moments: strings(r.moments),
      ...('string' === typeof r.status ? { status: r.status } : {}),
    };
  } catch {
    return { moments: [] };
  }
}

async function writeTold(deps: Pick<ToolDeps, 'fs'>, root: string, told: Told): Promise<void> {
  await deps.fs.writeFile(join(root, MOMENTS_FILE), JSON.stringify(told));
}

/** Tests only. */
export function resetPlatformMoments(): void {
  seen.clear();
}
