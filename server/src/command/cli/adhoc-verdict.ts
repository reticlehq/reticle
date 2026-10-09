import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { LOOPBACK_HOST, MCP_SSE_PATH } from '@reticlehq/core';
import { TOKEN_QUERY_PARAM } from '@/portal/bridge/token-auth.js';
import { ReticleTool } from '@reticlehq/core';
import { decideOpen } from '@/command/cli/launch/cli-launch.js';

/**
 * A verdict from the CLI, against the daemon that is already running.
 *
 * THE DEAD END THIS REMOVES. The tools are not loaded in the client, and there is no other supported
 * way to reach a verdict from that state. The shape is always the same: the app is instrumented, the
 * daemon is healthy, `doctor` shows a live connected page, and the client (Codex, Cursor Cloud, Antigravity,
 * Gemini CLI, or a Claude Code session whose MCP link dropped) exposes no `reticle_*` tools, because
 * they load only at client startup. The documented CLI fallback then refused, because the daemon
 * already owned the port — precisely the state a successful install leaves you in. The other CLI
 * verdict paths need saved flows, and a first-install project has none. And our own guidance says
 * never to stop the daemon, because that kills the agent's MCP link.
 *
 * So an agent held a live, correctly-wired app and no path to a verdict short of a human restarting
 * their editor.
 *
 * HOW, AND WHY IT ADDS NO NEW SURFACE. The full tool surface is already drivable over the daemon's
 * HTTP/SSE transport with a hand-written client. That transport is not opt-in — `start()` calls `attachMcp` unconditionally, so every daemon has it. So
 * this asks the running daemon the same questions an agent would, over the same transport, using the
 * MCP client the SDK already ships. Nothing new is exposed and nothing is bound: the daemon keeps
 * the port, the agent keeps its link, and there is nothing to stop.
 *
 * It is deliberately the CLI equivalent of ONE `act_and_wait`: navigate, then assert. A CLI that
 * grew its own scripting language would be a second way to express a journey, competing with flows
 * and drifting from them.
 */

/** What a one-shot verdict reports back to the caller. */
export interface AdhocVerdict {
  /** Process exit code: 0 only when the predicate was PROVED. */
  code: number;
  /** Lines to print, in order. */
  lines: string[];
}

interface AdhocVerdictOptions {
  port: number;
  /** Navigated to first when given; omitted to assert against wherever the session already is. */
  url?: string;
  /** The predicate, already parsed from the caller's JSON. */
  predicate: unknown;
  /**
   * Which connected tab to drive and grade. Omitted means "whatever is connected".
   *
   * It was parsed by `parseVerifySuffix` and never passed on, so with more than one tab open the
   * call failed with "multiple sessions connected — pass sessionId to target one" and there was no
   * way to follow that advice from here. Worse than a dead end: with several tabs it also graded
   * against whichever one the daemon picked.
   */
  sessionId?: string;
  token?: string;
  /** The caller's project `.reticle`: a lease opened here writes its runs there. */
  root?: string;
  /** Injected so a test does not need a live daemon. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
  /**
   * The tabs the daemon has connected, so a url with none on its origin can be opened here rather
   * than refused. Absent = never lease, which is the old behaviour and what the unit tests that do
   * not care get.
   */
  sessions?: () => Promise<readonly { url: string; sessionId?: string }[]>;
}

/** The lease tool is reached through `reticle_run`, the route that works on every tool profile. */
const LeaseAction = { ACQUIRE: 'acquire', RELEASE: 'release' } as const;

/**
 * Generous on purpose: on a machine with no Chrome, Edge or Playwright Chromium the FIRST lease
 * downloads Chromium before it can open anything (see launch-chromium), which outlives the MCP
 * client's 60s default and would report a timeout for a lease that was about to succeed.
 */
const LEASE_TIMEOUT_MS = 300_000;

const leaseFailedLine = (url: string): string =>
  `could not open ${url} in a Reticle browser, so nothing was checked:`;

/**
 * Open `url` in a Reticle-leased browser when the daemon has no tab on its origin.
 *
 * `{}` means a tab is already there (drive it); `{ leased }` names the lease this call opened, which
 * the caller must hand to `releaseLease`; `{ failed }` is the lease's own refusal, as lines to print —
 * a missing browser, an app that is not up — so nothing is asserted against a page that never opened.
 */
export async function leaseIfNoTab(
  caller: ToolCaller,
  url: string,
  sessions: () => Promise<readonly { url: string }[]>,
  /** The caller's project `.reticle`, so the lease's runs land where this command looks. */
  root?: string,
): Promise<{ leased?: string; alreadyAt?: boolean } | { failed: string[] }> {
  const open = [...(await sessions())];
  if ('open' !== decideOpen(open, url).action) {
    return open.some((s) => sameDocument(s.url, url)) ? { alreadyAt: true } : {};
  }
  return acquireLease(caller, url, false, root);
}

/**
 * Whether the tab named by `sessionId` already shows `url`'s document.
 *
 * Read from the same status the unpinned path reads. A status read that fails, or a session the
 * daemon does not list, answers false: navigating is the old behaviour, so a doubt costs a reload
 * rather than an assert against a page that is not there.
 */
async function pinnedTabIsAt(
  sessions: () => Promise<readonly { url: string; sessionId?: string }[]>,
  sessionId: string,
  url: string,
): Promise<boolean> {
  try {
    const pinned = (await sessions()).find((s) => s.sessionId === sessionId);
    return pinned !== undefined && sameDocument(pinned.url, url);
  } catch {
    return false;
  }
}

/**
 * Whether two urls name the same document, ignoring a trailing slash and the hash.
 *
 * `verify <url>` navigated a tab already showing that url, which reloads it. In a desktop window
 * that reload is a disconnect: the assert ran against a session that was gone ~20ms later and
 * answered `unknown — session disconnected`.
 */
function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL): string => u.pathname.replace(/\/+$/, '');
    return x.origin === y.origin && path(x) === path(y) && x.search === y.search;
  } catch {
    return false;
  }
}

/**
 * Open `url` in a Reticle-leased browser unconditionally: `{ leased }` names the lease, which the
 * caller hands to `releaseLease`; `{ failed }` is the lease's own refusal, as lines to print.
 * `init`'s connect proof on a machine with no system browser takes this path directly.
 */
export async function acquireLease(
  caller: ToolCaller,
  url: string,
  /** Open it in a window somebody can watch, whatever the daemon was started as. */
  headed?: boolean,
  /** The `.reticle` the lease's runs belong in: the caller's project, not wherever the page resolves. */
  root?: string,
): Promise<{ leased: string; zeroInstall: boolean } | { failed: string[] }> {
  const acquired = await caller.call(
    ReticleTool.RUN,
    {
      tool: ReticleTool.LEASE,
      args: {
        action: LeaseAction.ACQUIRE,
        url,
        ...(true === headed ? { headed } : {}),
        ...(root === undefined ? {} : { root }),
      },
    },
    LEASE_TIMEOUT_MS,
  );
  const report = verdictOf(acquired, 'sessionId');
  const sessionId = report?.['sessionId'];
  // `zeroInstall`: the page never dialled in, so the lease supplied Reticle's own reader.
  if ('string' === typeof sessionId) {
    return { leased: sessionId, zeroInstall: true === report?.['zeroInstall'] };
  }
  const why = verdictOf(acquired, 'error')?.['error'];
  return {
    failed: [
      leaseFailedLine(url),
      'string' === typeof why ? why : (refusalText(acquired) ?? JSON.stringify(acquired)),
    ],
  };
}

/** Hand back a lease `leaseIfNoTab` opened. Best-effort: an expired lease is already gone. */
export async function releaseLease(caller: ToolCaller, sessionId: string): Promise<void> {
  await caller
    .call(ReticleTool.RUN, {
      tool: ReticleTool.LEASE,
      args: { action: LeaseAction.RELEASE, sessionId },
    })
    .catch(() => undefined);
}

/** The narrow slice of an MCP client this needs — one call, then close. */
export interface ToolCaller {
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

/** `verified` is the only field that decides the exit code. Everything else is for the reader. */
const PROVED = 'yes';

export function endpointFor(port: number, token: string | undefined): URL {
  const url = new URL(`http://${LOOPBACK_HOST}:${String(port)}${MCP_SSE_PATH}`);
  if (token !== undefined && token.length > 0) url.searchParams.set(TOKEN_QUERY_PARAM, token);
  return url;
}

export async function connectOverSse(endpoint: URL): Promise<ToolCaller> {
  const client = new Client({ name: 'reticle-cli', version: '1' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(endpoint));
  return {
    call: async (name, args, timeoutMs) =>
      await client.callTool(
        { name, arguments: args },
        undefined,
        timeoutMs === undefined ? undefined : { timeout: timeoutMs },
      ),
    close: async () => {
      await client.close();
    },
  };
}

/**
 * The report object an MCP tool result carries, or undefined when the shape is not one.
 *
 * `field` is the key that makes a payload the report this caller wants: `verified` for a one-shot
 * verdict, `status` for a suite. It is a parameter rather than a fixed name because the suite path
 * reproduced this function's own incident the moment it reused it — the headline printed
 * `unverifiable` while the JSON under it said `"status":"fail"` with 74 failing flows, because a
 * suite report has no `verified` key and the text reader would only accept one that did.
 */
export function verdictOf(
  result: unknown,
  field: string = 'verified',
): Record<string, unknown> | undefined {
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if ('object' === typeof structured && null !== structured) {
    return structured as Record<string, unknown>;
  }
  // A daemon that answers with the verdict as TEXT left this undefined, so the headline read
  // `verified: unknown` while the JSON printed underneath it said `"verified":"no"` — one response
  // giving two answers to the same question. The text is the same object, so read it.
  return verdictFromText(result, field);
}

/** The report object inside an MCP text part, when the result carried it there instead. */
function verdictFromText(result: unknown, field: string): Record<string, unknown> | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    const text = (part as { text?: unknown }).text;
    if ('string' !== typeof text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      // Only a shape that actually carries a verdict — anything else stays `unknown`, which is the
      // honest answer for a result this function could not read.
      if ('object' === typeof parsed && null !== parsed && field in parsed) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* Not JSON; the next part may still be. */
    }
  }
  return undefined;
}

/**
 * The tool's own words when it refused, rather than the envelope carrying them.
 *
 * A refusal from these tools is the most useful text they produce — it names the cause and the next
 * action — and printing the MCP result object around it buries that in JSON escaping. The reader is
 * at a terminal; give them the sentence.
 */
export function refusalText(result: unknown): string | undefined {
  const r = result as { isError?: unknown; content?: unknown } | undefined;
  if (true !== r?.isError || !Array.isArray(r.content)) return undefined;
  const text = r.content
    .map((part) => (part as { text?: unknown }).text)
    .filter((t): t is string => 'string' === typeof t)
    .join('\n');
  if (0 === text.length) return undefined;
  // The tools answer with a JSON envelope whose `error` is the sentence; unwrap when it is one.
  try {
    const parsed: unknown = JSON.parse(text);
    const inner = (parsed as { error?: unknown } | undefined)?.error;
    return 'string' === typeof inner ? inner : text;
  } catch {
    return text;
  }
}

/**
 * Navigate (optionally) and assert, against the daemon already on this port.
 *
 * Exit code 0 ONLY for `verified: "yes"`. `unknown` exits non-zero on purpose: it means Reticle could
 * not tell what happened, and a CI step that treats "could not tell" as success is the false green
 * this whole product exists to prevent.
 */
export async function runAdhocVerdict(options: AdhocVerdictOptions): Promise<AdhocVerdict> {
  const connect = options.connect ?? connectOverSse;
  let caller: ToolCaller;
  try {
    caller = await connect(endpointFor(options.port, options.token));
  } catch (error) {
    return {
      code: 1,
      lines: [
        `could not reach the daemon on port ${String(options.port)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'It answers `reticle status`; if that works and this does not, the daemon is older than this CLI.',
      ],
    };
  }
  let leased: string | undefined;
  try {
    // Spread rather than set: an explicit `sessionId: undefined` is a key the tools reject as an
    // unknown parameter, which would turn "no tab named" into a refusal.
    const url = options.url !== undefined && options.url.length > 0 ? options.url : undefined;
    // A url and no tab on its origin: this used to refuse with "open the app first" and name some
    // OTHER listening port as the one to open. The caller already said which url; open it here, in
    // a Reticle browser, and hand the lease back when the verdict is in.
    let alreadyAt = false;
    // A named tab gets the same same-document rule: navigating to the url it already shows is a
    // reload, which throws away client-only state (page 2, a half-filled form) and in a desktop
    // window disconnects the session the assert is about to read (#1409).
    if (url !== undefined && options.sessionId !== undefined && options.sessions !== undefined) {
      alreadyAt = await pinnedTabIsAt(options.sessions, options.sessionId, url);
    }
    if (url !== undefined && options.sessionId === undefined && options.sessions !== undefined) {
      const opened = await leaseIfNoTab(caller, url, options.sessions, options.root);
      if ('failed' in opened) return { code: 1, lines: ['verified: unknown', ...opened.failed] };
      leased = opened.leased;
      alreadyAt = true === opened.alreadyAt;
    }
    const aimed = options.sessionId ?? leased;
    const pin = aimed === undefined ? {} : { sessionId: aimed };
    // A fresh lease, or a tab already showing this url, is already AT it; navigating again would
    // only reload the page — and reload a desktop window out from under the assert.
    if (url !== undefined && leased === undefined && !alreadyAt) {
      await caller.call(ReticleTool.NAVIGATE, { url, ...pin });
    }
    const result = await caller.call(ReticleTool.ASSERT, { predicate: options.predicate, ...pin });
    const refusal = refusalText(result);
    if (refusal !== undefined) {
      return { code: 1, lines: [`verified: unknown`, refusal] };
    }
    const verdict = verdictOf(result);
    // Narrowed rather than stringified: these arrive as `unknown` off a record, and a verdict field
    // that is accidentally an object must not print as `[object Object]` in the one line a reader
    // acts on.
    const asText = (value: unknown): string | undefined =>
      'string' === typeof value ? value : undefined;
    const verified = asText(verdict?.['verified']);
    const reason = asText(verdict?.['verifiedReason']) ?? asText(verdict?.['failureReason']);
    const lines = [
      `verified: ${verified ?? 'unknown'}`,
      ...(reason === undefined ? [] : [`reason: ${reason}`]),
      JSON.stringify(verdict ?? result, null, 2),
    ];
    return { code: PROVED === verified ? 0 : 1, lines };
  } catch (error) {
    return {
      code: 1,
      lines: [
        `the verdict could not be taken: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    if (leased !== undefined) await releaseLease(caller, leased);
    await caller.close().catch(() => undefined);
  }
}

const EXPLORE_ACTION = 'explore';
const DRIVE_RUNNING = 'running';
/** The most one explore call waits on its drive (the tool's own ceiling), and the call's slack. */
const EXPLORE_WAIT_MAX_S = 240;
const CALL_SLACK_MS = 15_000;
const MS_PER_S = 1000;

/**
 * One Harness drive through the daemon, polled to its end or until `budgetMs` runs out.
 *
 * An explore answers `{ status: "running", runId }` when its drive outlasts the call's wait, so a
 * caller that wants the finished report asks again by `runId` rather than starting a second drive.
 */
export async function exploreToEnd(
  caller: ToolCaller,
  args: Record<string, unknown>,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<unknown> {
  const deadline = now() + budgetMs;
  const ask = (more: Record<string, unknown>): Promise<unknown> => {
    const wait = Math.max(
      0,
      Math.min(EXPLORE_WAIT_MAX_S, Math.floor((deadline - now() - CALL_SLACK_MS) / MS_PER_S)),
    );
    return caller.call(
      ReticleTool.VERIFY,
      { ...more, action: EXPLORE_ACTION, wait },
      wait * MS_PER_S + CALL_SLACK_MS,
    );
  };
  let result = await ask(args);
  for (;;) {
    const report = verdictOf(result, 'status');
    const runId = report?.['runId'];
    if (DRIVE_RUNNING !== report?.['status'] || 'string' !== typeof runId || now() >= deadline)
      return result;
    result = await ask({ runId });
  }
}
