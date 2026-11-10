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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runCompare, type OpenedPage } from '@/features/compare/behaviour-compare.js';
import { compareReportHtml } from '@/features/compare/compare-report-html.js';
import { invalidComparison, type BehaviourComparison } from '@/features/compare/behaviour-diff.js';
import {
  compareExitCode,
  compareReportJson,
  compareReportLines,
  type CompareTimings,
  type CompareUrls,
} from '@/features/compare/behaviour-report.js';
import { DriverLostError } from '@/features/compare/build-readings.js';
import {
  StateDeclarationSchema,
  readStateSources,
  type StateIo,
  type StateSource,
} from '@/features/compare/outside/state-sources.js';
import { consoleLines, networkLines } from '@/features/compare/outside/effect-lines.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
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
const MSG_STATE_UNREADABLE = 'could not read the state sources in';
/** How long one state source read may take. */
const STATE_READ_MS = 60_000;
/** The most output one state command may give. */
const STATE_OUTPUT_BYTES = 64 * 1024 * 1024;
const SHELL = 'sh';
const SHELL_COMMAND_FLAG = '-c';
const DOCKER = 'docker';
const DOCKER_EXEC = 'exec';
const UTF8 = 'utf8';

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
  /** `--report <file>`: also write the comparison as an HTML page there. */
  report?: string;
  /** Injected so a test can capture the report; the default writes the file. */
  writeReport?: (path: string, html: string) => void;
  /** The path of the declared state sources file (`--state`). */
  state?: string;
}

export const MSG_REPORT_WRITTEN = 'Report:';
export const MSG_REPORT_FAILED = 'Report not written:';

function writeReportFile(path: string, html: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
}

interface ReportSink {
  path: string;
  write: (path: string, html: string) => void;
}

const execFileText = promisify(execFile);

/** State sources read on this machine: a shell, `docker exec`, `fetch` and the file system. */
const hostStateIo: StateIo = {
  async run(command, container) {
    const [file, args] =
      container === undefined
        ? [SHELL, [SHELL_COMMAND_FLAG, command]]
        : [DOCKER, [DOCKER_EXEC, container, SHELL, SHELL_COMMAND_FLAG, command]];
    const { stdout } = await execFileText(file, args, {
      encoding: UTF8,
      timeout: STATE_READ_MS,
      maxBuffer: STATE_OUTPUT_BYTES,
    });
    return stdout;
  },
  async fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(STATE_READ_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    return response.json();
  },
  readFile: (path) => readFile(path, UTF8),
};

/** The sources in the `--state` file, or why they could not be read. */
async function loadStateSources(path: string): Promise<StateSource[] | { error: string }> {
  try {
    const parsed = StateDeclarationSchema.safeParse(JSON.parse(await readFile(path, UTF8)));
    return parsed.success ? parsed.data.sources : { error: parsed.error.message };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
  sink?: ReportSink,
): { code: number; lines: string[] } {
  const report = compareReportJson(urls, result, timings);
  // A report that could not be written says so: a line in text mode, a field in the one JSON object.
  let reportError: string | undefined;
  if (sink !== undefined) {
    try {
      sink.write(sink.path, compareReportHtml(report));
    } catch (error) {
      reportError = error instanceof Error ? error.message : String(error);
    }
  }
  if (json) {
    return {
      code: compareExitCode(result),
      lines: [JSON.stringify(reportError === undefined ? report : { ...report, reportError })],
    };
  }
  const lines = compareReportLines(urls, result, timings);
  if (sink !== undefined) {
    lines.push(
      reportError === undefined
        ? `${MSG_REPORT_WRITTEN} ${sink.path}`
        : `${MSG_REPORT_FAILED} ${sink.path}: ${reportError}`,
    );
  }
  return { code: compareExitCode(result), lines };
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
  const sink: ReportSink | undefined =
    options.report === undefined
      ? undefined
      : { path: options.report, write: options.writeReport ?? writeReportFile };
  let readState: (() => Promise<string[]>) | undefined;
  if (options.state !== undefined) {
    const loaded = await loadStateSources(options.state);
    if ('error' in loaded) {
      const reason = `${MSG_STATE_UNREADABLE} ${options.state}: ${loaded.error}`;
      return render(options.json, urls, invalidComparison(reason, 0), undefined, sink);
    }
    readState = () => readStateSources(loaded, hostStateIo);
  }
  const connect = options.connect ?? connectOverSse;
  let caller: ToolCaller;
  try {
    caller = await connect(endpointFor(options.port, options.token));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const reason = `${MSG_NO_DAEMON} ${String(options.port)}: ${why}`;
    return render(options.json, urls, invalidComparison(reason, 0), undefined, sink);
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
      ...(readState === undefined ? {} : { readState }),
    });
    return render(options.json, urls, result, timings, sink);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return render(options.json, urls, invalidComparison(reason, 0), undefined, sink);
  } finally {
    await caller.close().catch(() => undefined);
  }
}

/**
 * The command. It needs a daemon, as an agent does: `ensureDaemon` attaches to the one on the port,
 * or starts one. Nothing here stops a daemon, so an agent's MCP link stays up.
 */
export async function handleCompare(
  parsed: CompareUrls & { json: boolean; port: number; report?: string; state?: string },
  ensureDaemon: (port: number) => Promise<void>,
  out: { line: (text: string) => void; exit: (code: number) => void },
): Promise<void> {
  const fail = (reason: string): void => {
    const sink =
      parsed.report === undefined ? undefined : { path: parsed.report, write: writeReportFile };
    const result = render(parsed.json, parsed, invalidComparison(reason, 0), undefined, sink);
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
