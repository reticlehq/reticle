/**
 * Open a realm as a session, and close what was opened (#2557).
 *
 * A task crosses realms: a change is driven in a page, and its mail opens in a desktop application.
 * Every realm joins the same bridge, but each one started its own way: the agent ran
 * `reticle-computer` by hand, or `reticle_attach_tab`. So an agent could not open the realm where
 * the next proof lives, and nothing closed what it opened.
 *
 * `open` starts the realm and answers with the session it became. `close` ends a session that the
 * same agent opened, and only that: a session a person or another agent opened is theirs. When the
 * agent leaves, every realm it opened is closed after a short grace.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ReticleEnv, ReticleTool } from '@reticlehq/core';
import { z } from 'zod';

import { detachTabs } from '@/portal/pool/attach-tab.js';
import { runAttachTab, type AttachIo } from './attach-tab-tool.js';
import { sessionIdShape, type ToolDef, type ToolDeps } from './tool-kit.js';

export const Realm = {
  COMPUTER: 'computer',
  BROWSER: 'browser',
} as const;
export type Realm = (typeof Realm)[keyof typeof Realm];

/** A desktop application can take a while: `npx` may download the computer realm first. */
const DEFAULT_OPEN_MS = 120_000;
const MAX_OPEN_MS = 300_000;
/** How long a closed process may take to stop before it is killed. */
const STOP_MS = 5_000;
/** The grace after an agent leaves: a proxy that reconnects keeps what it opened (as leases do). */
export const LEAVE_GRACE_MS = 30_000;
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const ERROR_TAIL = 600;

interface ChildLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: (event: 'exit', listener: (code: number | null) => void) => unknown;
  on: (event: 'exit' | 'error', listener: (arg: unknown) => void) => unknown;
}

/** What open and close use. Tests give their own. */
export interface RealmIo {
  spawn?: (cmd: string, args: readonly string[]) => ChildLike;
  computerCommand?: () => { cmd: string; args: string[] };
  attach?: AttachIo;
  detach?: (cdpUrl: string) => Promise<number>;
  /** The text of ~/.reticle/computer.json, or undefined when there is none. */
  ownerSettings?: () => string | undefined;
}

/** The file of the person at the machine, which the computer realm reads too. */
const OWNER_SETTINGS_FILE = 'computer.json';

function readOwnerSettings(): string | undefined {
  try {
    return readFileSync(join(homedir(), '.reticle', OWNER_SETTINGS_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether the person listed this app as one an agent may open: `"open": ["Mail", "Notes"]` in
 * ~/.reticle/computer.json. A tool call is not a terminal command, so the approval prompt an agent
 * shows before `reticle-computer` does not ask the person; their list does instead. An agent that
 * changes the file runs a terminal command, and that prompt asks.
 */
function listedToOpen(app: string, settingsText: string | undefined): boolean {
  const parsed = safeJson(settingsText ?? '');
  const list = z.object({ open: z.array(z.string()) }).safeParse(parsed);
  return list.success && list.data.open.some((one) => one.toLowerCase() === app.toLowerCase());
}

interface Opened {
  readonly sessionId: string;
  readonly realm: Realm;
  readonly owner: string | undefined;
  readonly close: () => Promise<void>;
}

/** Every realm opened through `open` on this daemon, by session id. */
const opened = new Map<string, Opened>();
const leaving = new Map<string, NodeJS.Timeout>();

/**
 * The command that joins a desktop application. `npx` runs the computer realm of this release, so
 * the server and the realm speak the same version. On Windows `npx` is a `.cmd` file that needs a
 * shell, and a shell would read the application's name: run npm's own script with Node instead.
 */
/**
 * The release of this server. Every package is published in lockstep, so the version of
 * @reticlehq/core is the version of the computer realm to run; it is read here, and not from the
 * server's identity module, so that the tools do not reach into `command/`.
 */
function releaseVersion(): string {
  return (createRequire(import.meta.url)('@reticlehq/core/package.json') as { version: string })
    .version;
}

function defaultComputerCommand(): { cmd: string; args: string[] } {
  const own = process.env[ReticleEnv.COMPUTER_BIN];
  if (own !== undefined && '' !== own) {
    return { cmd: own, args: [] };
  }
  const npx = ['-y', '-p', `@reticlehq/computer@${releaseVersion()}`, 'reticle-computer'];
  if ('win32' === process.platform) {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    return { cmd: process.execPath, args: [cli, ...npx] };
  }
  return { cmd: 'npx', args: npx };
}

const defaultSpawn = (cmd: string, args: readonly string[]): ChildLike =>
  nodeSpawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

function stopProcess(child: ChildLike): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((done) => {
    const hard = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, STOP_MS);
    child.once('exit', () => {
      clearTimeout(hard);
      done();
    });
    child.kill('SIGTERM');
  });
}

/** The first line of the computer realm that says it joined, or why it did not. */
function waitForJoin(
  child: ChildLike,
  timeoutMs: number,
): Promise<{ sessionId: string; answer: Record<string, unknown> } | { error: string }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (
      value: { sessionId: string; answer: Record<string, unknown> } | { error: string },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish({
          error:
            `the computer realm did not join in ${String(timeoutMs)} ms. ${err.slice(-ERROR_TAIL)}`.trim(),
        }),
      timeoutMs,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      for (const line of out.split('\n')) {
        const parsed = z
          .object({ joined: z.literal(true), sessionId: z.string() })
          .passthrough()
          .safeParse(safeJson(line));
        if (parsed.success) {
          finish({ sessionId: parsed.data.sessionId, answer: parsed.data });
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('error', (error) => finish({ error: String((error as Error).message ?? error) }));
    child.on('exit', () =>
      finish({
        error: (err.trim() || 'the computer realm stopped before it joined').slice(-ERROR_TAIL),
      }),
    );
  });
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

async function openComputer(
  deps: ToolDeps,
  args: Record<string, unknown>,
  io: RealmIo,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const app = 'string' === typeof args['app'] ? args['app'] : '';
  if ('' === app) {
    return {
      ok: false,
      error:
        'give `app`: the name of the desktop application, as the Dock or the task bar shows it.',
    };
  }
  if (!listedToOpen(app, (io.ownerSettings ?? readOwnerSettings)())) {
    return {
      ok: false,
      realm: Realm.COMPUTER,
      error: `the person has not allowed an agent to open ${app}. Ask them to add it to ~/.reticle/computer.json, as { "open": ["${app}"] }. Do not change that file yourself.`,
    };
  }
  const { cmd, args: pre } = (io.computerCommand ?? defaultComputerCommand)();
  const child = (io.spawn ?? defaultSpawn)(cmd, [
    ...pre,
    '--app',
    app,
    ...(true === args['launch'] ? ['--open'] : []),
  ]);
  const joined = await waitForJoin(child, timeoutMs);
  if ('error' in joined) {
    await stopProcess(child);
    return { ok: false, realm: Realm.COMPUTER, error: joined.error };
  }
  opened.set(joined.sessionId, {
    sessionId: joined.sessionId,
    realm: Realm.COMPUTER,
    owner: deps.attachId,
    close: () => stopProcess(child),
  });
  return {
    ok: true,
    realm: Realm.COMPUTER,
    sessionId: joined.sessionId,
    app,
    next: `Give sessionId "${joined.sessionId}" to every call on it. Close it with reticle_run { tool: "reticle_close_realm", args: { sessionId: "${joined.sessionId}" } } when the task is done.`,
  };
}

async function openBrowser(
  deps: ToolDeps,
  args: Record<string, unknown>,
  io: RealmIo,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const cdpUrl =
    ('string' === typeof args['cdpUrl'] ? args['cdpUrl'] : undefined) ??
    process.env[ReticleEnv.CDP_URL] ??
    DEFAULT_CDP_URL;
  const answer = await runAttachTab(
    deps,
    { match: args['match'], cdpUrl, waitMs: Math.min(timeoutMs, 60_000) },
    io.attach,
  );
  const sessionId = answer['sessionId'];
  if (true !== answer['ok'] || 'string' !== typeof sessionId) {
    return { ...answer, realm: Realm.BROWSER };
  }
  opened.set(sessionId, {
    sessionId,
    realm: Realm.BROWSER,
    owner: deps.attachId,
    close: async () => {
      const session = deps.sessions.get(sessionId);
      if (session !== undefined) {
        deps.sessions.park(session);
      }
      // The tab gets its page security back once no tab opened over that browser is left.
      const others = [...opened.values()].some(
        (o) => o.realm === Realm.BROWSER && o.sessionId !== sessionId,
      );
      if (!others) {
        await (io.detach ?? detachTabs)(cdpUrl);
      }
    },
  });
  return { ...answer, realm: Realm.BROWSER };
}

export function openRealm(
  deps: ToolDeps,
  args: Record<string, unknown>,
  io: RealmIo = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = Math.min(
    'number' === typeof args['timeoutMs'] ? args['timeoutMs'] : DEFAULT_OPEN_MS,
    MAX_OPEN_MS,
  );
  if (Realm.COMPUTER === args['realm']) {
    return openComputer(deps, args, io, timeoutMs);
  }
  if (Realm.BROWSER === args['realm']) {
    return openBrowser(deps, args, io, timeoutMs);
  }
  return Promise.resolve({
    ok: false,
    error: `realm is "computer" (a desktop application, with \`app\`) or "browser" (a tab of the person's browser, with \`match\`).`,
  });
}

export async function closeRealm(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = 'string' === typeof args['sessionId'] ? args['sessionId'] : '';
  const entry = opened.get(sessionId);
  if (entry === undefined) {
    return {
      ok: false,
      error: `session "${sessionId}" was not opened with reticle_open_realm, so close does not end it. To end a session for good, use reticle_session { action: "end" }.`,
    };
  }
  if (entry.owner !== deps.attachId) {
    return {
      ok: false,
      error: `session "${sessionId}" was opened by another agent; it closes it.`,
    };
  }
  opened.delete(sessionId);
  await entry.close();
  return { ok: true, closed: sessionId, realm: entry.realm };
}

/** Close every realm one agent opened. Answers with their session ids. */
export async function closeOpenedBy(owner: string | undefined): Promise<string[]> {
  const mine = [...opened.values()].filter((o) => o.owner === owner);
  for (const entry of mine) {
    opened.delete(entry.sessionId);
  }
  await Promise.all(mine.map((o) => o.close()));
  return mine.map((o) => o.sessionId);
}

/** The agent left: close what it opened after the grace, unless it comes back first. */
export function closeOpenedAfterGrace(owner: string): void {
  keepOpenedOf(owner);
  const timer = setTimeout(() => {
    leaving.delete(owner);
    void closeOpenedBy(owner);
  }, LEAVE_GRACE_MS);
  timer.unref();
  leaving.set(owner, timer);
}

/** The agent came back within the grace: it keeps what it opened. */
export function keepOpenedOf(owner: string): void {
  const timer = leaving.get(owner);
  if (timer !== undefined) {
    clearTimeout(timer);
    leaving.delete(owner);
  }
}

const RealmSchema = z.enum([Realm.COMPUTER, Realm.BROWSER]);

export const OPEN_REALM_TOOL: ToolDef = {
  name: ReticleTool.OPEN_REALM,
  description:
    'Open a realm as a session, and answer with its sessionId. realm "computer" joins a desktop application by `app` (with `launch: true` it starts it first); realm "browser" joins the one tab of the person\'s browser whose address holds `match`. Only an app the person listed in ~/.reticle/computer.json ("open": [...]) is opened, and a password vault or a sign-in page is never joined. Close it with reticle_close_realm { sessionId } when the task is done; when you leave, what you opened is closed.',
  inputSchema: {
    realm: RealmSchema.describe('"computer" (an app) or "browser" (a tab).'),
    app: z.string().min(1).optional().describe('computer: the app name.'),
    launch: z.boolean().optional().describe('computer: start it first.'),
    match: z.string().min(1).optional().describe('browser: part of the tab address.'),
  },
  handler: (deps, args) => openRealm(deps, args),
};

export const CLOSE_REALM_TOOL: ToolDef = {
  name: ReticleTool.CLOSE_REALM,
  description:
    'Close a session that you opened with reticle_open_realm: a desktop application leaves Reticle (the application keeps running), and a tab gets its page security back. A session you did not open is refused; to end one for good, use reticle_session { action: "end" }.',
  // The shared shape: a sessionId of its own, with other bounds, made the merged field contested and
  // joined every member's text into it, 3.6 kB on every turn. close checks for an empty id itself.
  inputSchema: { ...sessionIdShape },
  handler: (deps, args) => closeRealm(deps, args),
};
