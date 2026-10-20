/**
 * The saved-flow suite, against the daemon that is already running.
 *
 * `runAdhocVerdict` next door removed one half of a dead end: an agent whose client never loaded
 * the `reticle_*` tools could not reach a verdict, because `verify` refuses when the daemon owns
 * the port and a working install is exactly the state where the daemon owns the port.
 *
 * This is the other half. `--expect` serves a project with NO saved flows; a project WITH them was
 * still stuck, and worse off, because the whole promise of a saved suite is that it runs again
 * without an agent. The documented way out was to stop the daemon, which kills the agent's MCP
 * link, and our own guidance says never to do it.
 *
 * Same trick, and deliberately no new surface: ask the running daemon the question an agent would
 * ask it, over the transport `start()` already attaches unconditionally. Nothing is bound, nothing
 * is stopped, the agent keeps its link.
 */
import { CALL_SECRETS_ARG } from '@/surface/tools/tool-kit.js';
import { ReticleTool } from '@reticlehq/core';
import { cutOffReason } from '@/surface/tools/harness-explore.js';
import { KEY_REFUSED_HEAD, RESULT_FIELD } from '@/surface/tools/reticle-result.js';
import {
  connectOverSse,
  endpointFor,
  exploreToEnd,
  leaseIfNoTab,
  releaseLease,
  refusalText,
  verdictOf,
  type AdhocVerdict,
  type ToolCaller,
} from './adhoc-verdict.js';

export interface AdhocSuiteOptions {
  port: number;
  /** Run only flows carrying ANY of these labels. Omitted runs the whole suite. */
  select?: string[];
  /** Which connected tab to drive. Omitted means "whatever is connected". */
  sessionId?: string;
  /** Acknowledge the replay guard's destructive steps for this run only. */
  confirmDangerous?: boolean;
  token?: string;
  /** Injected so a test does not need a live daemon. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
  /**
   * The url `reticle verify` was given, and the tabs the daemon has: with no tab on its origin, the
   * suite runs in a Reticle browser opened at it. It answered "no browser session connected" instead.
   */
  url?: string;
  sessions?: () => Promise<readonly { url: string }[]>;
  /** The caller's project `.reticle`: a lease opened here writes its runs there. */
  root?: string;
}

/** The only status that is a pass. `unverifiable` means nothing was checked, which is not one. */
const PASSED = 'pass';

/** The `reticle_verify` actions this file asks for. */

/**
 * How long a SUITE may take, against the SDK's 60s default for one request.
 *
 * A suite is not one request's worth of work: it replays every saved flow, each of which drives a
 * real browser through a real journey, and a project with a few dozen of them takes minutes. The
 * default timed the call out mid-run and reported "the suite could not be run", which is a sentence
 * about the transport wearing the shape of a verdict — the flows were running the whole time.
 *
 * Found by driving it against a real daemon on a project with 45 saved flows.
 */
const SUITE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run the saved suite through the daemon on this port.
 *
 * Exit code 0 ONLY for `status: "pass"`. `unverifiable` exits non-zero on purpose: it is what an
 * empty suite reports, and a CI step that reads "nothing was checked" as success is the false green
 * this product exists to prevent.
 */
export async function runAdhocSuite(options: AdhocSuiteOptions): Promise<AdhocVerdict> {
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
    const url = options.url !== undefined && 0 < options.url.length ? options.url : undefined;
    if (url !== undefined && options.sessionId === undefined && options.sessions !== undefined) {
      const opened = await leaseIfNoTab(caller, url, options.sessions, options.root);
      if ('failed' in opened) return { code: 1, lines: ['status: unverifiable', ...opened.failed] };
      leased = opened.leased;
    }
    return await replaySuite(caller, {
      ...options,
      ...(leased === undefined ? {} : { sessionId: leased }),
    });
  } catch (error) {
    return {
      code: 1,
      lines: [
        `the suite could not be run: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    if (leased !== undefined) await releaseLease(caller, leased);
    await caller.close().catch(() => undefined);
  }
}

/** This command's `RETICLE_SECRET_*` values, as the per-call `secrets` argument; none, no field. */
function secretsArg(env: NodeJS.ProcessEnv): { [CALL_SECRETS_ARG]?: Record<string, string> } {
  const secrets = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith(SECRET_ENV_PREFIX) &&
        'string' === typeof entry[1] &&
        0 < entry[1].length,
    ),
  );
  return 0 === Object.keys(secrets).length ? {} : { [CALL_SECRETS_ARG]: secrets };
}

/** The prefix of a variable holding one redacted field's value. */
const SECRET_ENV_PREFIX = 'RETICLE_SECRET_';

/** The saved suite through an open connection, as a verdict. Shared by the suite and explore paths. */
async function replaySuite(
  caller: ToolCaller,
  options: { select?: string[]; sessionId?: string; confirmDangerous?: boolean },
): Promise<AdhocVerdict> {
  // Spread rather than set: an explicit `undefined` is a key the tools reject as an unknown
  // parameter, which would turn "no tab named" into a refusal. Same rule as the one-shot path.
  const result = await caller.call(
    ReticleTool.VERIFY,
    {
      action: 'flows',
      ...(options.select === undefined ? {} : { labels: options.select }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(true === options.confirmDangerous ? { confirmDangerous: true } : {}),
      // The running daemon's environment is not this command's: the secrets a CI step set for
      // `reticle verify` go with the call, for this call only.
      ...secretsArg(process.env),
    },
    SUITE_TIMEOUT_MS,
  );
  const refusal = refusalText(result);
  if (refusal !== undefined) return { code: 1, lines: ['status: unverifiable', refusal] };
  const report = verdictOf(result, 'status');
  const status = 'string' === typeof report?.['status'] ? report['status'] : 'unverifiable';
  const summary = 'string' === typeof report?.['summary'] ? report['summary'] : undefined;
  // Its last line says where the run lives (dashboard link, or kept on this machine only).
  const block = 'string' === typeof report?.[RESULT_FIELD] ? report[RESULT_FIELD] : undefined;
  // A pass the platform will never see is not a green CI step: its key was refused.
  const refusedKey = true === block?.includes(`- ${KEY_REFUSED_HEAD}`);
  return {
    code: PASSED === status && !refusedKey ? 0 : 1,
    lines: [
      `status: ${status}`,
      ...(summary === undefined ? [] : [summary]),
      ...(block === undefined ? [] : [block]),
      JSON.stringify(report ?? result, null, 2),
    ],
  };
}

export interface AdhocExploreOptions {
  port: number;
  /** The app to explore; opened in a Reticle browser when the daemon has no tab on its origin. */
  url: string;
  /** Who to be, or what to accomplish. */
  persona?: string;
  token?: string;
  connect?: (endpoint: URL) => Promise<ToolCaller>;
  /** The tabs the daemon has connected. See runAdhocVerdict. */
  sessions: () => Promise<readonly { url: string }[]>;
  /** The caller's project `.reticle`: a lease opened here writes its runs there. */
  root?: string;
}

/**
 * `verify <url> --explore` against the daemon that already owns the port: open the url, let the
 * daemon's model drive it and record flows, then replay them — the same three steps the path that
 * boots its own daemon takes, so the exit code means the same thing on both.
 *
 * It used to refuse here, and that refusal was the first thing a new user met: `init` leaves its
 * daemon on the port and then recommends exactly this command as the first run.
 */
export async function runAdhocExplore(options: AdhocExploreOptions): Promise<AdhocVerdict> {
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
      ],
    };
  }
  let leased: string | undefined;
  try {
    const opened = await leaseIfNoTab(caller, options.url, options.sessions, options.root);
    if ('failed' in opened) return { code: 1, lines: ['status: unverifiable', ...opened.failed] };
    leased = opened.leased;
    const pin = leased === undefined ? {} : { sessionId: leased };
    const drove = await exploreToEnd(
      caller,
      {
        ...(options.persona === undefined ? {} : { persona: options.persona }),
        ...pin,
      },
      SUITE_TIMEOUT_MS,
    );
    const refusal = refusalText(drove);
    if (refusal !== undefined) return { code: 1, lines: ['status: unverifiable', refusal] };
    const report = verdictOf(drove, 'savedFlows');
    const recorded = [report?.['savedFlows'], report?.['rewroteFlows']].flatMap((list) =>
      Array.isArray(list) ? list.filter((name): name is string => 'string' === typeof name) : [],
    );
    const summary = 'string' === typeof report?.['summary'] ? report['summary'] : undefined;
    const note = 'string' === typeof report?.['note'] ? report['note'] : undefined;
    const drive = [
      ...(summary === undefined ? [] : [summary]),
      ...(note === undefined ? [] : [note]),
    ];
    const cut = cutOffReason(report ?? {});
    if (cut !== undefined) return { code: 1, lines: ['status: unverifiable', ...drive, cut] };
    // A drive that left nothing to replay proved nothing, however long it ran.
    if (0 === recorded.length) return { code: 1, lines: ['status: unverifiable', ...drive] };
    const suite = await replaySuite(caller, pin);
    return { code: suite.code, lines: [...drive, ...suite.lines] };
  } catch (error) {
    return {
      code: 1,
      lines: [
        `the explore could not be run: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    if (leased !== undefined) await releaseLease(caller, leased);
    await caller.close().catch(() => undefined);
  }
}
