/**
 * The episode log: every tool call an agent made, in full, and what each one did to the app.
 *
 * `.reticle/episodes/<episodeId>.jsonl`, one file per agent connection and project. The first line
 * says where the work started (the git HEAD, the uncommitted change, the user's request); every
 * line after it is one call: the tool, its arguments, its whole result or error, when it started
 * and ended, the tab it drove, the agent that made it, and the events the page emitted while it ran.
 *
 * The journal (`sessions/<id>/`) keeps the page's events and the actions that drove it, but not the
 * reads, not the results, and not the calls made before a tab connected. Together they are the
 * trajectory: what the agent was asked, what it did, what it was told, and what the app did.
 *
 * LOCAL ONLY. Nothing here is sent: the sync reads no file in `episodes/`, and the one place that
 * could is `episodesMaySync`, which needs both an explicit project opt-in and a workspace that
 * consented to share its data. It obeys the journal switch (`RETICLE_JOURNAL`, `"journal": false`).
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ReticleDir, type DrivenBy, type ReticleEvent } from '@reticlehq/core';
import { PromptContextSchema, type PromptContext } from '@reticlehq/core/artifacts';
import { withoutTypedInput } from './journal-recorder.js';
import { noteEpisode } from '@/hooks/episode-stamp.js';

const run = promisify(execFile);

/** Per-record schema version, the same convention as the journal's. */
export const EPISODE_FILE_VERSION = 1;

export const EpisodeRecordKind = { START: 'start', CALL: 'call' } as const;
export type EpisodeRecordKind = (typeof EpisodeRecordKind)[keyof typeof EpisodeRecordKind];

/** One field past this many characters keeps its head and is named in the record's `truncated`. */
export const MAX_EPISODE_FIELD_CHARS = 200_000;
/** A page can emit thousands of events in one call; past this many the record keeps the first ones. */
const MAX_EFFECT_EVENTS = 500;
/** A checkout with a huge uncommitted change keeps the first files and says how many more. */
const MAX_CHANGED_FILES = 500;
const GIT_TIMEOUT_MS = 5_000;
/** The id for calls that came over no MCP connection (the CLI, the programmatic invoker). */
export const UNATTACHED_EPISODE = 'unattached';

/** The repository as the episode found it. `failed` says why git could not answer. */
export type GitAtStart =
  | {
      head: string;
      changed: { file: string; added: number | null; removed: number | null }[];
      moreChanged?: number;
    }
  | { failed: string };

export interface EpisodeCallInput {
  tool: string;
  args: Record<string, unknown>;
  /** Wall-clock ms, from the caller's injected clock. */
  startedAt: number;
  endedAt: number;
  result?: unknown;
  error?: string;
  sessionId?: string;
  agent?: string;
  drivenBy?: DrivenBy;
  /** The events the page emitted between the call's start and its end, already attributed. */
  effect?: readonly ReticleEvent[];
  /** The coding agent's own session id, as its MCP server announced it. */
  agentSession?: string;
}

interface EpisodeLogDeps {
  /** The project's `.reticle` root. */
  root: string;
  episodeId: string;
  now: () => number;
  /** Injected for the tests; the real one asks git in the project directory. */
  git?: (projectDir: string) => Promise<GitAtStart>;
  /** False when the journal is switched off: nothing is written. */
  enabled?: boolean;
}

export interface EpisodeLog {
  record: (call: EpisodeCallInput) => void;
  /** Wait for every queued line to reach the disk. */
  flush: () => Promise<void>;
}

export function episodePath(root: string, episodeId: string): string {
  return join(root, ReticleDir.EPISODES_SUBDIR, `${episodeId}.jsonl`);
}

/** The value as kept: whole, or its first characters when its JSON is too long. */
function capped(value: unknown): { value: unknown; cut: boolean } {
  const text = JSON.stringify(value ?? null);
  return text.length > MAX_EPISODE_FIELD_CHARS
    ? { value: { head: text.slice(0, MAX_EPISODE_FIELD_CHARS) }, cut: true }
    : { value, cut: false };
}

function effectOf(events: readonly ReticleEvent[]): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const seqs = events.map((e) => e.seq).filter((s): s is number => s !== undefined);
  return {
    counts,
    ...(0 === seqs.length ? {} : { seqRange: { from: Math.min(...seqs), to: Math.max(...seqs) } }),
    events: events.slice(0, MAX_EFFECT_EVENTS),
    ...(events.length > MAX_EFFECT_EVENTS ? { moreEvents: events.length - MAX_EFFECT_EVENTS } : {}),
  };
}

/** HEAD and the uncommitted change against it, per file. Never throws. */
export async function gitAtStart(projectDir: string): Promise<GitAtStart> {
  try {
    const opts = { cwd: projectDir, timeout: GIT_TIMEOUT_MS };
    const head = (await run('git', ['rev-parse', 'HEAD'], opts)).stdout.trim();
    const numstat = (await run('git', ['diff', '--numstat', 'HEAD'], opts)).stdout;
    const all = numstat
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [added = '', removed = '', ...file] = line.split('\t');
        const count = (n: string): number | null => (/^\d+$/.test(n) ? Number(n) : null);
        return { file: file.join('\t'), added: count(added), removed: count(removed) };
      });
    return {
      head,
      changed: all.slice(0, MAX_CHANGED_FILES),
      ...(all.length > MAX_CHANGED_FILES ? { moreChanged: all.length - MAX_CHANGED_FILES } : {}),
    };
  } catch (error: unknown) {
    return {
      failed: error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error),
    };
  }
}

function requestIn(root: string): PromptContext | undefined {
  try {
    const parsed = PromptContextSchema.safeParse(
      JSON.parse(readFileSync(join(root, ReticleDir.REQUEST_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function createEpisodeLog(deps: EpisodeLogDeps): EpisodeLog {
  const path = episodePath(deps.root, deps.episodeId);
  const git = deps.git ?? gitAtStart;
  let chain: Promise<void> = Promise.resolve();
  let n = 0;
  const append = (line: () => Promise<Record<string, unknown>>): void => {
    // A log that cannot be written never fails the call it describes.
    chain = chain
      .then(async () => appendFile(path, `${JSON.stringify(await line())}\n`))
      .catch(() => undefined);
  };
  return {
    record: (call) => {
      if (false === deps.enabled) return;
      noteEpisode(deps.root, deps.episodeId, {
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        ...(call.agentSession === undefined ? {} : { agentSession: call.agentSession }),
      });
      n += 1;
      if (1 === n) {
        // The start is taken at the first call: that is when the agent began working through us.
        const at = deps.now();
        const request = requestIn(deps.root);
        append(async () => {
          await mkdir(dirname(path), { recursive: true });
          return {
            v: EPISODE_FILE_VERSION,
            kind: EpisodeRecordKind.START,
            episodeId: deps.episodeId,
            at,
            ...(call.agent === undefined ? {} : { agent: call.agent }),
            ...(call.agentSession === undefined ? {} : { agentSession: call.agentSession }),
            git: await git(dirname(deps.root)).then((found) => {
              if ('head' in found) noteEpisode(deps.root, deps.episodeId, { head: found.head });
              return found;
            }),
            ...(request === undefined ? {} : { request }),
          };
        });
      }
      const args = capped(withoutTypedInput(call.args));
      const outcome = call.error === undefined ? capped(call.result) : undefined;
      const truncated = [
        ...(args.cut ? ['args'] : []),
        ...(true === outcome?.cut ? ['result'] : []),
      ];
      const record = {
        v: EPISODE_FILE_VERSION,
        kind: EpisodeRecordKind.CALL,
        n,
        tool: call.tool,
        args: args.value,
        ...(outcome === undefined ? { error: call.error } : { result: outcome.value }),
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        ...(call.agent === undefined ? {} : { agent: call.agent }),
        ...(call.drivenBy === undefined ? {} : { drivenBy: call.drivenBy }),
        ...(call.effect === undefined || 0 === call.effect.length
          ? {}
          : { effect: effectOf(call.effect) }),
        ...(0 === truncated.length ? {} : { truncated }),
      };
      append(() => Promise.resolve(record));
    },
    flush: () => chain,
  };
}

/** One log per project root and connection, for the daemon's lifetime. */
const open = new Map<string, EpisodeLog>();
/**
 * Set at start from the journal switch, by `attachJournal`, which both daemon paths call. Off until
 * then, so a process that never started a daemon (a test, a library caller) writes nothing.
 */
let enabledInDaemon = false;

export function setEpisodeLogEnabled(enabled: boolean): void {
  enabledInDaemon = enabled;
}

/** Append one call to its episode. The entry point the tool dispatcher uses. */
export function recordEpisodeCall(
  root: string,
  attachId: string | undefined,
  now: () => number,
  call: EpisodeCallInput,
): void {
  if (!enabledInDaemon) return;
  const episodeId = attachId ?? UNATTACHED_EPISODE;
  const key = `${root}\n${episodeId}`;
  let log = open.get(key);
  if (log === undefined) {
    log = createEpisodeLog({
      root,
      episodeId,
      now,
      enabled: enabledInDaemon,
    });
    open.set(key, log);
  }
  log.record(call);
}

/**
 * May an episode leave this machine? Only when the project opted in (`"sync": { "episodes": true }`
 * in `cloud.json`) AND the platform says the workspace consented to share its data. Unknown consent
 * is no consent. No sync path calls this yet: there is no platform endpoint to receive an episode.
 */
export function episodesMaySync(
  cloud: { config: unknown; policy: { episodes?: boolean } },
  workspaceConsent: boolean | undefined,
): boolean {
  return null !== cloud.config && true === cloud.policy.episodes && true === workspaceConsent;
}

/** The record kinds the agent hooks write beside the daemon's (`reticle hook tool`). */
export const AgentRecordKind = {
  TOOL: 'agent_tool',
  MODEL: 'agent_model',
  STOP: 'agent_stop',
} as const;
/** An agent hook's file: `agent-<session>.jsonl`, beside the daemon's episodes. */
export const AGENT_FILE_PREFIX = 'agent-';

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);

function readLines(path: string): Json[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return isJson(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** The same agent: a hook names it `cursor`, an MCP handshake `cursor-vscode`. */
const sameAgent = (hook: unknown, run: string): boolean => {
  if ('string' !== typeof hook || 0 === hook.length) return false;
  const a = hook.toLowerCase();
  const b = run.toLowerCase();
  return a.includes(b) || b.includes(a);
};

/** The hook file of one agent session: the id as the hook wrote it into the file name. */
const agentFileOf = (session: string): string =>
  `${AGENT_FILE_PREFIX}${session.replace(/[^\w-]/g, '_')}.jsonl`;

/**
 * The agent's model and the claim that closed the run's turn, from the agent hooks' records in
 * this project's episodes. The turn is the run's: its claim is the first `agent_stop` at or after
 * the run's last Reticle call (from its episode, else its `createdAt`); a later stop belongs to a
 * later turn. The model is the newest `agent_model` record, or the `model` a tool or stop record
 * carried, at or before that point.
 *
 * Whose records: the run's own agent session (`agentSession`, announced by its MCP server) when it
 * names one. Otherwise the same agent's, by name, and only when they all come from one session:
 * two sessions of one agent in a project and no session on the run is unknown, never a guess.
 */
export function agentContextFor(
  root: string,
  run: { episodeId?: unknown; createdAt?: unknown; agent?: unknown; agentSession?: unknown },
): { model?: string; claim?: { text: string; at: number } } {
  const agentId = isJson(run.agent) ? run.agent['id'] : undefined;
  if ('string' !== typeof agentId) return {};
  const dir = join(root, ReticleDir.EPISODES_SUBDIR);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return {};
  }
  const calls =
    'string' === typeof run.episodeId ? readLines(join(dir, `${run.episodeId}.jsonl`)) : [];
  const ends = calls.map((c) => c['endedAt']).filter((t): t is number => 'number' === typeof t);
  const lastCall =
    0 < ends.length ? Math.max(...ends) : 'number' === typeof run.createdAt ? run.createdAt : 0;
  const own = 'string' === typeof run.agentSession ? agentFileOf(run.agentSession) : undefined;
  const bySession = files
    .filter((file) => (own === undefined ? file.startsWith(AGENT_FILE_PREFIX) : own === file))
    .map((file) =>
      readLines(join(dir, file)).filter((r) => own !== undefined || sameAgent(r['agent'], agentId)),
    )
    .filter((lines) => 0 < lines.length);
  if (1 < bySession.length) return {};
  const records = bySession
    .flat()
    .map((r) => ({ r, at: 'number' === typeof r['at'] ? r['at'] : Number(r['endedAt'] ?? 0) }))
    .sort((a, b) => a.at - b.at);
  const stop = records.find(({ r, at }) => AgentRecordKind.STOP === r['kind'] && at >= lastCall);
  const until = stop?.at ?? lastCall;
  const model = records
    .filter(({ r, at }) => at <= until && 'string' === typeof r['model'])
    .map(({ r }) => r['model'] as string)
    .at(-1);
  const message = isJson(stop?.r['message']) ? stop?.r['message']['head'] : undefined;
  return {
    ...(model === undefined ? {} : { model }),
    ...(stop === undefined || 'string' !== typeof message
      ? {}
      : { claim: { text: message, at: stop.at } }),
  };
}
