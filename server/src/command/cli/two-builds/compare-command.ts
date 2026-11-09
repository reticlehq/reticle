/**
 * `reticle compare <reference-url> <candidate-url> [--base <url>] [--json]`.
 *
 * Drives two running builds of one app the same way and reports each difference in what a person
 * sees, for example main against a pull request preview. The app needs nothing installed: each run
 * is a tab the daemon leases, and a page with no Reticle SDK gets the daemon's own reader. The rules
 * are in `@/features/compare/behaviour-compare.ts`; this file connects them to the daemon over its
 * MCP transport, with the same tool calls an agent makes.
 */
import {
  ActionType,
  isLocalhostSubdomain,
  isLoopbackHostname,
  ReticleTool,
  SnapshotMode,
} from '@reticlehq/core';
import { runCompare, type OpenedPage } from '@/features/compare/behaviour-compare.js';
import { invalidComparison, type BehaviourComparison } from '@/features/compare/behaviour-diff.js';
import {
  compareExitCode,
  compareReportJson,
  compareReportLines,
  type CompareTimings,
  type CompareUrls,
} from '@/features/compare/behaviour-report.js';
import { DriverLostError } from '@/features/compare/build-readings.js';
import { consoleLines, networkLines } from '@/features/compare/outside/effect-lines.js';
import { callerArtifactRoot } from '@/memory/project/link-directory.js';
import {
  defaultPairingTokenDir,
  readOrCreatePairingTokenSync,
} from '@/portal/bridge/pairing-token.js';
import {
  acquireLease,
  connectOverSse,
  endpointFor,
  payloadOf,
  refusalText,
  releaseLease,
  type ToolCaller,
} from '../daemon-link/daemon-client.js';

/** How long a navigation may take before the start page counts as not loaded. */
const NAVIGATE_WAIT_MS = 15_000;
/** Room for one tool call past its own wait. */
const CALL_MS = 60_000;
/** The most network calls and console lines read for one sequence. */
const EFFECTS_LIMIT = 50;
/** How long fetching one page or script file may take. */
const FETCH_MS = 10_000;
/**
 * Refusals that mean the driver lost its tab, not that the build did something. A run that sees
 * one proves nothing about the build.
 */
const DRIVER_LOST =
  /no browser session connected|no connected session|multiple sessions connected|session disconnected|names no session|no such session|session ended/i;
const MSG_NO_DAEMON = 'could not reach the daemon on port';
const MSG_LEASE_FAILED = 'could not open a browser on';

const asText = (value: unknown): string | undefined =>
  'string' === typeof value ? value : undefined;

/** The pairing token the daemon asks for, or undefined when there is none. */
export function pairingToken(): string | undefined {
  const token = readOrCreatePairingTokenSync(defaultPairingTokenDir());
  return token === undefined || 0 === token.length ? undefined : token;
}

/**
 * A build on loopback or a `*.localhost` name is a disposable copy, so compare presses its guarded
 * controls too ("Place order", "Delete"): they are the actions most worth comparing. On any other
 * host the act guard stays on, so a compare can never delete real data.
 */
function isDisposableBuild(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return isLoopbackHostname(hostname) || isLocalhostSubdomain(hostname);
  } catch {
    return false;
  }
}

/** The act tool's args: a press names its key as `text`, a fill or a select its `value`. */
function actArgs(
  action: string,
  value: string | undefined,
  guarded: Record<string, unknown>,
): Record<string, unknown> {
  if (value === undefined) {
    return guarded;
  }
  return ActionType.PRESS === action ? { text: value, ...guarded } : { value, ...guarded };
}

/** One leased tab as the compare driver. Every call goes through `reticle_run` on that tab. */
export function leasedPage(caller: ToolCaller, url: string, sessionId: string): OpenedPage {
  let id = sessionId;
  const guarded = isDisposableBuild(url) ? { confirmDangerous: true } : {};
  const run = async (
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = CALL_MS,
  ): Promise<{ payload: Record<string, unknown>; refusal?: string }> => {
    let result: unknown;
    try {
      result = await caller.call(
        ReticleTool.RUN,
        { tool, args: { ...args, sessionId: id } },
        timeoutMs,
      );
    } catch (error) {
      // Name the call, so a run that lost its driver says where.
      throw new DriverLostError(
        `${tool}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const payload = payloadOf(result);
    const refusal = refusalText(result) ?? asText(payload['error']);
    if (refusal !== undefined && DRIVER_LOST.test(refusal)) {
      throw new DriverLostError(`${tool}: ${refusal}`);
    }
    return refusal === undefined ? { payload } : { payload, refusal };
  };
  const navigate = async (to: string): Promise<boolean> => {
    const { payload, refusal } = await run(
      ReticleTool.NAVIGATE,
      { url: to, timeout_ms: NAVIGATE_WAIT_MS },
      NAVIGATE_WAIT_MS * 2,
    );
    id = asText(payload['sessionId']) ?? id;
    return refusal === undefined && true === payload['ok'] && false !== payload['confirmed'];
  };
  /** Faults stay on the tab until cleared, and each fresh sequence must see the real server. */
  let mocked = false;
  const mockRequests = async (args: Record<string, unknown>): Promise<boolean> => {
    const { payload, refusal } = await run(ReticleTool.NETWORK_MOCK, args);
    return refusal === undefined && true === payload['applied'];
  };
  return {
    async open() {
      if (mocked) {
        if (!(await mockRequests({ clear: true }))) {
          return false;
        }
        mocked = false;
      }
      return navigate(url);
    },
    mock(rules) {
      mocked = true;
      return mockRequests({ mocks: rules });
    },
    goto(query) {
      return navigate(new URL(query, url).href);
    },
    async read() {
      const { payload } = await run(ReticleTool.SNAPSHOT, { mode: SnapshotMode.FULL, ids: true });
      return asText(payload['tree']) ?? '';
    },
    async act(at, action, value) {
      const { payload, refusal } = await run(ReticleTool.ACT, {
        ...('string' === typeof at ? { ref: at } : { target: at }),
        action,
        args: actArgs(action, value, guarded),
      });
      const ok = refusal === undefined && false !== payload['dispatched'];
      const since = payload['since'];
      return 'number' === typeof since ? { ok, since } : { ok };
    },
    async effects(since) {
      // A refused read is passed on as `{ error }`, so it becomes a visible line, not an empty list.
      const read = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        const { payload, refusal } = await run(tool, { since, ...args, limit: EFFECTS_LIMIT });
        return refusal === undefined ? payload : { error: refusal };
      };
      return [
        ...networkLines(await read(ReticleTool.NETWORK, { bodies: true })),
        ...consoleLines(await read(ReticleTool.CONSOLE, {})),
      ];
    },
    async close() {
      await releaseLease(caller, id);
    },
  };
}

export interface CompareCommandOptions extends CompareUrls {
  json: boolean;
  port: number;
  token?: string;
  /** The caller's project `.reticle`, where the leased tabs write their runs. */
  root?: string;
  /** Injected so a test can use its own transport. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetchText?: (url: string) => Promise<string | undefined>;
}

/** Fetch a page or script file as a browser would. Undefined when it could not be fetched. */
async function fetchText(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

/** The exit code, and the text or the one JSON line to print. */
function render(
  json: boolean,
  urls: CompareUrls,
  result: BehaviourComparison,
  timings?: CompareTimings,
): { code: number; lines: string[] } {
  return {
    code: compareExitCode(result),
    lines: json
      ? [JSON.stringify(compareReportJson(urls, result, timings))]
      : compareReportLines(urls, result, timings),
  };
}

/** Compare the builds through the daemon on `port`. Returns the lines to print and the exit code. */
export async function runCompareCommand(
  options: CompareCommandOptions,
): Promise<{ code: number; lines: string[] }> {
  const urls: CompareUrls = {
    reference: options.reference,
    candidate: options.candidate,
    ...(options.base === undefined ? {} : { base: options.base }),
  };
  const connect = options.connect ?? connectOverSse;
  let caller: ToolCaller;
  try {
    caller = await connect(endpointFor(options.port, options.token));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const reason = `${MSG_NO_DAEMON} ${String(options.port)}: ${why}`;
    return render(options.json, urls, invalidComparison(reason, 0));
  }
  const open = async (url: string): Promise<OpenedPage> => {
    const lease = await acquireLease(caller, url, false, options.root);
    if ('failed' in lease) {
      throw new Error([`${MSG_LEASE_FAILED} ${url}`, ...lease.failed].join(' '));
    }
    return leasedPage(caller, url, lease.leased);
  };
  try {
    const { result, timings } = await runCompare({
      ...urls,
      open,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? Date.now,
      fetchText: options.fetchText ?? fetchText,
    });
    return render(options.json, urls, result, timings);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return render(options.json, urls, invalidComparison(reason, 0));
  } finally {
    await caller.close().catch(() => undefined);
  }
}

/**
 * The command. It needs a daemon, as an agent does: `ensureDaemon` attaches to the one on the port,
 * or starts one. Nothing here stops a daemon, so an agent's MCP link stays up.
 */
export async function handleCompare(
  parsed: CompareUrls & { json: boolean; port: number },
  ensureDaemon: (port: number) => Promise<void>,
  out: { line: (text: string) => void; exit: (code: number) => void },
): Promise<void> {
  const fail = (reason: string): void => {
    const result = render(parsed.json, parsed, invalidComparison(reason, 0));
    result.lines.forEach(out.line);
    out.exit(result.code);
  };
  try {
    await ensureDaemon(parsed.port);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const token = pairingToken();
  const root = callerArtifactRoot(process.cwd());
  const result = await runCompareCommand({
    ...parsed,
    ...(token === undefined ? {} : { token }),
    ...(root === undefined ? {} : { root }),
  });
  result.lines.forEach(out.line);
  out.exit(result.code);
}
