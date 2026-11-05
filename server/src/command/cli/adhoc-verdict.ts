import { DEFAULT_ASSERT_TIMEOUT_MS, ReticleTool, asString as asText } from '@reticlehq/core';
import { decideOpen } from '@/command/cli/launch/cli-launch.js';
import {
  acquireLease,
  connectOverSse,
  endpointFor,
  refusalText,
  releaseLease,
  verdictOf,
  type ToolCaller,
} from './daemon-link/daemon-client.js';

// Re-exported so every existing importer of the daemon link through this file is unaffected.
export {
  acquireLease,
  connectOverSse,
  endpointFor,
  refusalText,
  releaseLease,
  verdictOf,
  type ToolCaller,
} from './daemon-link/daemon-client.js';

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
  /**
   * How long the predicate may take to come true, from `--timeout`. It was parsed and never passed
   * on, and the one-shot assert judged about a second after navigating, while the request the
   * predicate named was usually still in flight (#1533).
   */
  timeoutMs?: number;
}

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

/** How long `--expect` waits without a `--timeout`: the wait form's own default. */
const DEFAULT_EXPECT_WAIT_MS = DEFAULT_ASSERT_TIMEOUT_MS;
/** Room for the daemon to answer after the wait it was given has run out. */
const WAIT_CALL_SLACK_MS = 5_000;

/**
 * The longest one `reticle_assert` call waits: its `timeout_ms` cap, one MCP request less slack.
 * Named here rather than imported, because this directory does not reach the tool layer; pinned
 * equal to `MAX_BLOCKING_WAIT_MS` by adhoc-verdict.test.ts so the two cannot drift apart.
 */
export const ASSERT_MAX_WAIT_MS = 55_000;

/**
 * A refusal `reticle_run` hands back as an `{ error }` payload. The run route answers a tool's
 * refusal as data, not as `isError`, so `refusalText` alone read it as a verdict and printed
 * `verified: unknown` with the JSON instead of the sentence.
 */
function runRefusal(result: unknown): string | undefined {
  const said = verdictOf(result, 'error')?.['error'];
  return refusalText(result) ?? ('string' === typeof said ? said : undefined);
}

/**
 * Wait for the expectation, then grade it with ONE `reticle_assert` (#1533).
 *
 * The grade is `reticle_assert`'s, never the wait's: it journals, captures the assertion, and
 * carries `verifiedReason`, contradictions and coverage, which `reticle_wait_for` does not.
 * `reticle_assert` already waits when `timeout_ms > 0`, up to one request. A longer budget spends
 * the part one assert cannot hold in `reticle_wait_for` first, through `reticle_run` (the route
 * every tool profile has), following `resume_ms`, and then asserts. No `since` is passed by
 * either: both default to the same last-act cursor, and nothing here acts in between.
 */
async function waitForExpectation(
  caller: ToolCaller,
  predicate: unknown,
  pin: { sessionId?: string },
  timeoutMs: number | undefined,
): Promise<{ result: unknown } | { refused: string }> {
  const budget = Math.max(0, timeoutMs ?? DEFAULT_EXPECT_WAIT_MS);
  let settle = budget - ASSERT_MAX_WAIT_MS;
  while (0 < settle) {
    const waited = await caller.call(
      ReticleTool.RUN,
      { tool: ReticleTool.WAIT_FOR, args: { predicate, timeout_ms: settle, ...pin } },
      // The daemon blocks no longer than one request allows and answers resume_ms past that, so
      // the budget plus slack always outlasts the call.
      settle + WAIT_CALL_SLACK_MS,
    );
    const refused = runRefusal(waited);
    if (refused !== undefined) {
      return { refused };
    }
    // By `pass`, which every wait answers with: a "not yet" carries no `verified`.
    const report = verdictOf(waited, 'pass');
    const resume = report?.['resume_ms'];
    if (
      true === report?.['pass'] ||
      'number' !== typeof resume ||
      resume <= 0 ||
      resume >= settle
    ) {
      break;
    }
    settle = resume;
  }
  const assertMs = Math.min(budget, ASSERT_MAX_WAIT_MS);
  return {
    result: await caller.call(
      ReticleTool.ASSERT,
      { predicate, timeout_ms: assertMs, ...pin },
      assertMs + WAIT_CALL_SLACK_MS,
    ),
  };
}

/** `verified` is the only field that decides the exit code. Everything else is for the reader. */
const PROVED = 'yes';

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
      if ('failed' in opened) {
        return { code: 1, lines: ['verified: unknown', ...opened.failed] };
      }
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
    const waited = await waitForExpectation(caller, options.predicate, pin, options.timeoutMs);
    if ('refused' in waited) {
      return { code: 1, lines: ['verified: unknown', waited.refused] };
    }
    const result = waited.result;
    const refusal = refusalText(result);
    if (refusal !== undefined) {
      return { code: 1, lines: [`verified: unknown`, refusal] };
    }
    const verdict = verdictOf(result);
    // Narrowed rather than stringified: these arrive as `unknown` off a record, and a verdict field
    // that is accidentally an object must not print as `[object Object]` in the one line a reader
    // acts on.
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
    if (leased !== undefined) {
      await releaseLease(caller, leased);
    }
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
    if (DRIVE_RUNNING !== report?.['status'] || 'string' !== typeof runId || now() >= deadline) {
      return result;
    }
    result = await ask({ runId });
  }
}
