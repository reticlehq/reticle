/**
 * Codex's web search, imported from Codex's own session transcript.
 *
 * Codex's `web_search` is a hosted tool: it never reaches PostToolUse (stated in the Codex hooks
 * docs, and seen live on 2026-10-19). Codex does write it to its session transcript, which every
 * hook payload names in `transcript_path` (else `$CODEX_HOME/sessions/**` holds it, named by the
 * session id). So any Codex hook that fires (a tool call, the turn's Stop) reads that file and
 * appends each search it has not kept yet to the same `agent-<session>.jsonl`, as an `agent_tool`
 * record with `tool: "web_search"`.
 *
 * Two shapes, both read from real transcripts on this machine (structure only):
 * - Codex 0.160.0: `event_msg` → `item_completed` whose `item` is `{ type: "Extension",
 *   kind: "web.search", id, query, action, results[] }`, with `started_at_ms`/`completed_at_ms`.
 * - Older builds: `response_item` → `web_search_call` `{ status, action }`: no result, no id, and
 *   the line's `timestamp` is the only time.
 *
 * Idempotent: a search is keyed by its item id, else by its line number (the transcript is
 * append-only), and a key already in the session file is skipped. Read-only on Codex's files.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from '@/memory/intent/record-request.js';
import { AgentRecordKind, EPISODE_FILE_VERSION } from '@/memory/journal/episode-log.js';

export const CODEX_AGENT = 'codex';
/** The `source` of a record imported from Codex's transcript rather than handed over by a hook. */
export const CODEX_TRANSCRIPT_SOURCE = 'codex-transcript';
export const WEB_SEARCH_TOOL = 'web_search';
const CODEX_HOME_ENV = 'CODEX_HOME';
const CODEX_DIR = '.codex';
const SESSIONS_DIR = 'sessions';
const ITEM_COMPLETED = 'item_completed';
const EXTENSION_ITEM = 'Extension';
const WEB_SEARCH_KIND = 'web.search';
const WEB_SEARCH_CALL = 'web_search_call';
const RESPONSE_ITEM = 'response_item';
const FAILED = 'failed';
/** A result keeps this many characters, as the hook's own records do. */
const MAX_RESULT_TEXT = 4_000;
const MAX_ARG_TEXT = 2_000;
/** Codex's transcript holds the whole session. Past this size it is not read on a hook's time. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  'string' === typeof value && 0 < value.length ? value : undefined;

/** Codex's home: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return text(env[CODEX_HOME_ENV]) ?? join(homedir(), CODEX_DIR);
}

/**
 * The session's transcript: the payload's `transcript_path`, else the rollout file under
 * `<codexHome>/sessions/` whose name ends with the session id.
 * ponytail: walks every dated folder; a home with years of sessions would want the newest first.
 */
export function codexTranscriptPath(payload: Json, home: string): string | undefined {
  const given = text(payload['transcript_path']);
  if (given !== undefined) return given;
  const session = text(payload['session_id']);
  if (session === undefined) return undefined;
  const suffix = `-${session}.jsonl`;
  const walk = (dir: string): string | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(suffix)) return path;
      if (entry.isDirectory()) {
        const found = walk(path);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(join(home, SESSIONS_DIR));
}

/** Every string redacted and cut, project paths made relative, as the hook's own args are. */
function clean(value: unknown, base: string): unknown {
  if ('string' === typeof value)
    return redactSecrets(value.split(`${base}/`).join(''), MAX_ARG_TEXT);
  if (Array.isArray(value)) return value.map((item) => clean(item, base));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => null !== v && v !== undefined)
      .map(([k, v]) => [k, clean(v, base)]),
  );
}

/** One web search as an `agent_tool` record, or undefined when the line is not one. */
function searchFrom(line: Json, lineNo: number, session: string, base: string): Json | undefined {
  const payload = isObject(line['payload']) ? line['payload'] : undefined;
  if (payload === undefined) return undefined;
  const who = {
    v: EPISODE_FILE_VERSION,
    agent: CODEX_AGENT,
    agentSession: session,
    kind: AgentRecordKind.TOOL,
    source: CODEX_TRANSCRIPT_SOURCE,
    tool: WEB_SEARCH_TOOL,
  };
  const item = isObject(payload['item']) ? payload['item'] : undefined;
  if (
    ITEM_COMPLETED === payload['type'] &&
    item !== undefined &&
    EXTENSION_ITEM === item['type'] &&
    WEB_SEARCH_KIND === item['kind']
  ) {
    const started = payload['started_at_ms'];
    const ended = payload['completed_at_ms'];
    const action = isObject(item['action']) ? item['action'] : { query: item['query'] };
    const results = item['results'];
    const full = results === undefined ? undefined : JSON.stringify(results);
    return {
      ...who,
      toolUseId: text(item['id']) ?? `L${String(lineNo)}`,
      args: clean(action, base),
      ok: true,
      ...(full === undefined
        ? {}
        : {
            result: {
              head: redactSecrets(full, MAX_RESULT_TEXT),
              chars: full.length,
              truncated: full.length > MAX_RESULT_TEXT,
            },
          }),
      ...('number' === typeof started ? { startedAt: started } : {}),
      ...('number' === typeof ended ? { endedAt: ended } : {}),
      ...('number' === typeof started && 'number' === typeof ended
        ? { durationMs: ended - started }
        : {}),
    };
  }
  if (RESPONSE_ITEM === line['type'] && WEB_SEARCH_CALL === payload['type']) {
    const at = Date.parse(String(line['timestamp']));
    return {
      ...who,
      toolUseId: text(payload['id']) ?? `L${String(lineNo)}`,
      args: clean(isObject(payload['action']) ? payload['action'] : {}, base),
      ok: FAILED !== payload['status'],
      ...(Number.isFinite(at) ? { endedAt: at } : {}),
    };
  }
  return undefined;
}

/** The web searches in a transcript's text, oldest first. */
export function codexWebSearches(transcript: string, session: string, base: string): Json[] {
  return transcript.split('\n').flatMap((raw, index) => {
    if (!raw.includes(WEB_SEARCH_KIND) && !raw.includes(WEB_SEARCH_CALL)) return [];
    try {
      const line: unknown = JSON.parse(raw);
      const record = isObject(line) ? searchFrom(line, index + 1, session, base) : undefined;
      return record === undefined ? [] : [record];
    } catch {
      return [];
    }
  });
}

/** The searches not yet in `sessionFile`, by their `toolUseId`. */
export function newCodexSearches(searches: readonly Json[], sessionFile: string): Json[] {
  if (0 === searches.length) return [];
  const kept = new Set<unknown>();
  if (existsSync(sessionFile)) {
    for (const raw of readFileSync(sessionFile, 'utf8').split('\n')) {
      if (!raw.includes(CODEX_TRANSCRIPT_SOURCE)) continue;
      try {
        const line: unknown = JSON.parse(raw);
        if (isObject(line)) kept.add(line['toolUseId']);
      } catch {
        // A torn line names nothing.
      }
    }
  }
  return searches.filter((s) => !kept.has(s['toolUseId']));
}

/** The transcript's text, or undefined when it is missing or too large to read now. */
export function readTranscript(path: string): string | undefined {
  try {
    return statSync(path).size > MAX_TRANSCRIPT_BYTES ? undefined : readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
