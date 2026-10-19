/**
 * `reticle hook tool --agent <id>`: keep one of the coding agent's own tool calls.
 *
 * The agent's shell commands, file edits and web fetches never pass through Reticle's MCP tools,
 * so the daemon's episode log never saw them. The agent's post-tool hook hands each one over here.
 * It goes into the same `.reticle/episodes/` folder, one file per agent session
 * (`agent-<session>.jsonl`): the tool, its arguments, a head of its result and the result's size,
 * whether it failed, its exit code, and its timing. Every string passes the secret redaction first.
 *
 * LOCAL ONLY, under the same rules as the episode log: gitignored, swept by retention, never read
 * by the sync, and off with the journal (`RETICLE_JOURNAL=0`, `"journal": false`). Reticle's own
 * MCP tools are skipped, because the daemon already keeps them in full. Never throws.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { projectSetting, redactSecrets } from '@/memory/intent/record-request.js';
import {
  AGENT_FILE_PREFIX,
  AgentRecordKind,
  EPISODE_FILE_VERSION,
} from '@/memory/journal/episode-log.js';
import { captureRoots } from './prompt-hook.js';
import {
  CODEX_AGENT,
  codexHome,
  codexTranscriptPath,
  codexWebSearches,
  newCodexSearches,
  readTranscript,
} from './codex-transcript.js';

/** The `kind` of a record this hook writes, beside the daemon's `start` and `call`. */
export const AGENT_TOOL_RECORD = AgentRecordKind.TOOL;
/** The `kind` of a record that only names the agent's model (Claude Code's session start). */
export const AGENT_MODEL_RECORD = AgentRecordKind.MODEL;
/** The `kind` of the agent's closing message at the end of a turn. */
export const AGENT_STOP_RECORD = AgentRecordKind.STOP;

/**
 * The end-of-turn events whose payload carries the final message, and the field that holds it,
 * from each vendor's hook reference (2026-10-18). Copilot CLI's `agentStop` and Factory Droid's
 * `Stop` carry no message text, so they are not here.
 */
const STOP_MESSAGE_FIELD: Readonly<Record<string, string>> = {
  // Claude Code and Codex.
  Stop: 'last_assistant_message',
  // Cursor.
  afterAgentResponse: 'text',
  // Gemini CLI.
  AfterAgent: 'prompt_response',
};
/** Windsurf names its event in `agent_action_name`, and puts the text in `response`. */
const WINDSURF_STOP = 'post_cascade_response';
/** A result keeps this many characters; its full size is kept beside it. */
export const MAX_TOOL_TEXT = 4_000;
/** One argument string (a whole file a Write sends) keeps this many characters. */
const MAX_ARG_TEXT = 100_000;
/** Reticle's own tools, by the MCP name prefix every agent gives them. */
const RETICLE_TOOL = /^mcp__reticle/i;
const EXIT_CODE = /^Exit code (\d+)/;
const OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);
const JOURNAL_SETTING = 'journal';
const UNKNOWN_SESSION = 'unknown';
const BASH = 'Bash';
/**
 * Codex documents no error field on PostToolUse (2026-10-19): a failed shell command arrives like a
 * passing one, so the absence of an error says nothing about its exit code.
 */
const NO_FAILURE_SIGNAL: ReadonlySet<string> = new Set(['codex']);
const COPILOT_SUCCESS = 'success';
const UNKNOWN_MODEL = 'Unknown';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  'string' === typeof value && 0 < value.length ? value : undefined;

/**
 * Every string redacted and capped, at any depth. Says whether any string was cut. Paths inside the
 * project are made relative to it first: the redaction removes an absolute path whole, because a
 * home folder names a person, and the file an edit touched is the point of the record.
 */
function redacted(value: unknown, cut: { any: boolean }, base: string): unknown {
  if ('string' === typeof value) {
    if (value.length > MAX_ARG_TEXT) cut.any = true;
    return redactSecrets(value.split(`${base}/`).join(''), MAX_ARG_TEXT);
  }
  if (Array.isArray(value)) return value.map((item) => redacted(item, cut, base));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redacted(v, cut, base)]));
}

/** A result as kept: its redacted head, its full size, and whether the head is all of it. */
function resultOf(
  value: unknown,
  base: string,
): { head: string; chars: number; truncated: boolean } {
  const full = 'string' === typeof value ? value : JSON.stringify(value ?? null);
  return {
    head: redactSecrets(full.split(`${base}/`).join(''), MAX_TOOL_TEXT),
    chars: full.length,
    truncated: full.length > MAX_TOOL_TEXT,
  };
}

/**
 * The fields each agent names differently, read into one shape. From each vendor's hook reference
 * on 2026-10-18: Claude Code (`tool_response`, `error`, `duration_ms`, `session_id`), Cursor
 * (`tool_output`, `error_message`, `failure_type`, `duration` with no stated unit,
 * `conversation_id`, `model` on every hook), Codex (`tool_response`, `model` on every hook) and
 * Gemini CLI (`tool_response` with an optional `error` inside it; no model).
 */
function readPayload(payload: Json): {
  session: string | undefined;
  model: string | undefined;
  tool: string | undefined;
  input: unknown;
  response: unknown;
  error: string | undefined;
} {
  // Copilot CLI's camelCase result: `{ resultType, textResultForLlm }`, a failure unless `success`.
  const copilot = isObject(payload['toolResult']) ? payload['toolResult'] : undefined;
  const response = payload['tool_response'] ?? payload['tool_output'] ?? copilot;
  const inner = isObject(response) ? response['error'] : undefined;
  const innerError = text(inner) ?? (isObject(inner) ? text(inner['message']) : undefined);
  const copilotError =
    copilot !== undefined && COPILOT_SUCCESS !== copilot['resultType']
      ? (text(copilot['textResultForLlm']) ?? String(copilot['resultType']))
      : undefined;
  // Windsurf names the action, not a tool, and says "Unknown" when it does not know the model.
  const windsurfModel = text(payload['model_name']);
  const windsurfTool = isObject(payload['tool_info'])
    ? text(payload['agent_action_name'])
    : undefined;
  return {
    session:
      text(payload['session_id']) ??
      text(payload['conversation_id']) ??
      text(payload['sessionId']) ??
      text(payload['trajectory_id']),
    // `to_model` is Claude Code's PostModelSwitch; `model` is everyone else's.
    model:
      text(payload['model']) ??
      text(payload['to_model']) ??
      (UNKNOWN_MODEL === windsurfModel ? undefined : windsurfModel),
    tool: text(payload['tool_name']) ?? text(payload['toolName']) ?? windsurfTool,
    input: payload['tool_input'] ?? payload['toolArgs'] ?? payload['tool_info'] ?? {},
    response,
    error: text(payload['error']) ?? text(payload['error_message']) ?? innerError ?? copilotError,
  };
}

/** One record from a post-tool payload, or from a payload that only names the model. */
export function toolRecordFrom(
  agent: string,
  payload: unknown,
  now: number,
  base: string,
): Json | undefined {
  if (!isObject(payload)) return undefined;
  const { session, model, tool, input, response, error } = readPayload(payload);
  const who = {
    v: EPISODE_FILE_VERSION,
    agent,
    ...(session === undefined ? {} : { agentSession: session }),
    ...(model === undefined ? {} : { model }),
  };
  const event = text(payload['hook_event_name']);
  const field = event === undefined ? undefined : STOP_MESSAGE_FIELD[event];
  const info = isObject(payload['tool_info']) ? payload['tool_info'] : {};
  const windsurfStop = WINDSURF_STOP === payload['agent_action_name'];
  if (field !== undefined || windsurfStop) {
    const message = windsurfStop
      ? (text(payload['response']) ?? text(info['response']))
      : text(field === undefined ? undefined : payload[field]);
    // A stop with no message (Codex sends null when it has none) is still the end of the turn.
    return {
      ...who,
      kind: AGENT_STOP_RECORD,
      ...(message === undefined ? {} : { message: resultOf(message, base) }),
      at: now,
    };
  }
  if (tool === undefined) {
    // Claude Code names its model only at session start and on a switch, with no tool.
    return model === undefined ? undefined : { ...who, kind: AGENT_MODEL_RECORD, at: now };
  }
  if (RETICLE_TOOL.test(tool)) return undefined;
  const ok = error === undefined;
  const duration = payload['duration_ms'];
  const durationMs = 'number' === typeof duration && duration >= 0 ? duration : undefined;
  const reported = payload['duration'];
  const exit = error === undefined ? undefined : EXIT_CODE.exec(error)?.[1];
  const cut = { any: false };
  const args = redacted(input, cut, base);
  return {
    ...who,
    kind: AGENT_TOOL_RECORD,
    ...(text(payload['tool_use_id']) === undefined ? {} : { toolUseId: payload['tool_use_id'] }),
    tool,
    args,
    ...(cut.any ? { argsTruncated: true } : {}),
    ok,
    // A payload that carries no result (Windsurf's) gets none: an invented `null` reads as an answer.
    ...(ok
      ? response === undefined
        ? {}
        : { result: resultOf(response, base) }
      : { error: resultOf(error, base) }),
    ...(text(payload['failure_type']) === undefined
      ? {}
      : { failureType: payload['failure_type'] }),
    ...(exit !== undefined
      ? { exitCode: Number(exit) }
      : ok && BASH === tool && !NO_FAILURE_SIGNAL.has(agent)
        ? { exitCode: 0 }
        : {}),
    ...(true === payload['is_interrupt'] ? { interrupted: true } : {}),
    ...(durationMs === undefined ? {} : { startedAt: now - durationMs, durationMs }),
    // A duration whose unit the vendor does not state is kept as given, never converted.
    ...('number' === typeof reported ? { reportedDuration: reported } : {}),
    endedAt: now,
  };
}

export { toolHookAck } from './hook-fast.js';

interface CaptureIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
}

/** Keep one tool call. Never throws: the `.reticle` roots it wrote to, or none. */
export function captureToolCall(agent: string, raw: string, io: CaptureIo): { written: string[] } {
  try {
    if (OFF_VALUES.has((io.env[ReticleEnv.JOURNAL] ?? '').toLowerCase())) return { written: [] };
    const payload: unknown = JSON.parse(raw);
    if (!isObject(payload)) return { written: [] };
    const roots = Array.isArray(payload['workspace_roots']) ? payload['workspace_roots'] : [];
    // Windsurf puts the folder inside `tool_info` for a command, and nowhere for an edit: its hook
    // runs in the workspace root, which is `io.cwd`.
    const info = isObject(payload['tool_info']) ? payload['tool_info'] : {};
    const cwd = text(payload['cwd']) ?? text(roots[0]) ?? text(info['cwd']) ?? io.cwd;
    const record = toolRecordFrom(agent, payload, io.now(), cwd);
    const given = readPayload(payload).session;
    // Codex's web search reaches no hook: any Codex hook imports it from Codex's own transcript.
    const transcript =
      CODEX_AGENT === agent && given !== undefined
        ? codexTranscriptPath(payload, codexHome(io.env))
        : undefined;
    const body = transcript === undefined ? undefined : readTranscript(transcript);
    const searches =
      given === undefined || body === undefined ? [] : codexWebSearches(body, given, cwd);
    if (record === undefined && 0 === searches.length) return { written: [] };
    const session = (given ?? UNKNOWN_SESSION).replace(/[^\w-]/g, '_');
    const written: string[] = [];
    for (const root of captureRoots(cwd)) {
      if (false === projectSetting(dirname(root), JOURNAL_SETTING)) continue;
      const dir = join(root, ReticleDir.EPISODES_SUBDIR);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${AGENT_FILE_PREFIX}${session}.jsonl`);
      const lines = [
        ...newCodexSearches(searches, file),
        ...(record === undefined ? [] : [record]),
      ];
      if (0 === lines.length) continue;
      appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
      written.push(root);
    }
    return { written };
  } catch {
    return { written: [] };
  }
}
