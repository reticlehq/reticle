/**
 * The post-tool hook's fast path: answer at once, write in a detached child.
 *
 * Cursor and Gemini CLI wait for a hook to exit, and document no background option. Through the
 * full CLI the hook took p50 ~300 ms per call (100 synthetic payloads each), almost all of it
 * loading modules the hook never uses. `bin/reticle.js` sends `hook tool` here before the CLI
 * loads. This module imports only Node built-ins: it reads the payload, prints the agent's answer,
 * pipes the payload to a detached `hook tool-write` (the real capture, `tool-hook.ts`), and returns.
 *
 * Kept free of `@reticlehq/*` imports on purpose: every import here is paid on every tool call.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The actions the detached writers run. Not for people: `hook tool` and `hook prompt` are. */
export const TOOL_WRITE_ACTION = 'tool-write';
export const PROMPT_WRITE_ACTION = 'prompt-write';
/** The prompt's arrival time, handed to its writer: a writer that finishes late is still ordered. */
export const AT_FLAG = '--at';
const HOOK_COMMAND = 'hook';
const PROMPT_ACTION = 'prompt';
const WINDOWS = 'win32';
const CURSOR = 'cursor';
const GEMINI = 'gemini';
const CODEX = 'codex';
/** Read without parsing: the fast path pays for every byte of work on every call. */
const CODEX_STOP = /"hook_event_name"\s*:\s*"Stop"/;
/** The payload is a few kilobytes. More than this is not a hook payload, and is not read. */
const MAX_STDIN_BYTES = 1024 * 1024;
/** An agent that never closes stdin must still get its answer. */
const STDIN_WAIT_MS = 3_000;
/** `bin/reticle.js`, from `dist/command/cli/hook/hook-fast.js`. */
const BIN = fileURLToPath(new URL('../../../../bin/reticle.js', import.meta.url));

/**
 * This CLI's bin as an agent hook should name it: `$HOME/...` when under the home folder, so no
 * user name lands in a committed file; undefined on Windows, whose shells do not all read `||`
 * and `$HOME`, so the hooks there stay on npx alone. See `directHookCommand` in `@reticlehq/init`.
 */
export function hookBinFor(home: string, platform: string, bin: string = BIN): string | undefined {
  if (WINDOWS === platform) return undefined;
  const under = 0 < home.length && bin.startsWith(`${home}/`);
  return under ? `$HOME${bin.slice(home.length)}` : bin;
}

/** What the hook prints. Cursor and Gemini CLI read stdout as JSON; the rest need nothing. */
export function toolHookAck(agent: string, payload = ''): string {
  if (CURSOR === agent || GEMINI === agent) return '{}\n';
  // Codex's Stop rejects plain text and wants JSON when it exits 0; its other hooks need nothing.
  return CODEX === agent && CODEX_STOP.test(payload) ? '{}\n' : '';
}

/** What the prompt hook prints. Cursor reads `{ continue }`, Gemini CLI any JSON; the rest nothing. */
export function promptHookAck(agent: string): string {
  if (CURSOR === agent) return `${JSON.stringify({ continue: true })}\n`;
  return GEMINI === agent ? '{}\n' : '';
}

interface FastIo {
  readStdin: () => Promise<string>;
  write: (text: string) => void;
  /** Start the writer, detached, with `input` on its stdin. Resolves once the input is handed over. */
  spawnWriter: (args: readonly string[], input: string) => Promise<void>;
  now?: () => number;
}

const agentOf = (argv: readonly string[]): string => {
  const at = argv.indexOf('--agent');
  return (-1 === at ? undefined : argv[at + 1]) ?? 'claude-code';
};

export async function runToolHookFast(argv: readonly string[], io: FastIo): Promise<void> {
  const agent = agentOf(argv);
  const payload = await io.readStdin();
  io.write(toolHookAck(agent, payload));
  try {
    await io.spawnWriter([HOOK_COMMAND, TOOL_WRITE_ACTION, ...argv], payload);
  } catch {
    // A lost record is better than an agent told its tool failed.
  }
}

/**
 * The prompt hook: let the prompt through at once, keep it in a detached writer. The writer gets
 * the arrival time, so an older prompt never replaces a newer one however the writers finish.
 */
export async function runPromptHookFast(argv: readonly string[], io: FastIo): Promise<void> {
  const arrived = (io.now ?? Date.now)();
  const payload = await io.readStdin();
  io.write(promptHookAck(agentOf(argv)));
  try {
    await io.spawnWriter(
      [HOOK_COMMAND, PROMPT_WRITE_ACTION, ...argv, AT_FLAG, String(arrived)],
      payload,
    );
  } catch {
    // A prompt that is not kept must still go through.
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const done = (): void => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, STDIN_WAIT_MS);
    timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (MAX_STDIN_BYTES < data.length) {
        data = '';
        done();
      }
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function spawnWriter(args: readonly string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.on('error', reject);
    child.stdin.end(input, () => {
      child.unref();
      resolve();
    });
  });
}

/** The process entry `bin/reticle.js` calls for `hook tool` or `hook prompt`. Always exits 0. */
export async function mainHookFast(action: string, argv: readonly string[]): Promise<void> {
  const io = { readStdin, write: (text: string) => process.stdout.write(text), spawnWriter };
  if (PROMPT_ACTION === action) await runPromptHookFast(argv, io);
  else await runToolHookFast(argv, io);
  // Exit only once the answer is flushed: an exit can drop a pipe write still in flight.
  process.stdout.write('', () => process.exit(0));
}
