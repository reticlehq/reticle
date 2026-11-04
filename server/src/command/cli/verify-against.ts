/**
 * `reticle verify <candidate-url> --against <reference-url>`: did a change alter what users see?
 *
 * It drives both running builds with the same actions (the saved flows, and the explorer on the
 * reference) and reports each difference in what a person can read and use. The rules are in
 * `@/features/compare`. This file connects them to the running daemon: each run is a leased tab,
 * and each read or action is a tool call on that tab, the same calls an agent makes.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ReticleDir,
  ReticleTool,
  SnapshotMode,
  isConsequenceDrift,
  selectFlows,
  type DriftReason,
  type FlowFile,
} from '@reticlehq/core';
import { compareBuilds, type CompareDriver } from '@/features/compare/compare-run.js';
import { compareExit, compareJson, compareLines } from '@/features/compare/compare-report.js';
import { FlowStore } from '@/language/flows/flows.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { callerArtifactRoot } from '@/memory/project/link-directory.js';
import {
  defaultPairingTokenDir,
  readOrCreatePairingTokenSync,
} from '@/portal/bridge/pairing-token.js';
import {
  acquireLease,
  connectOverSse,
  endpointFor,
  refusalText,
  releaseLease,
  type ToolCaller,
} from './adhoc-verdict.js';

/** How long a navigation may take before the start page counts as not loaded. */
const NAVIGATE_WAIT_MS = 15_000;
/** One replayed flow step: a step can wait for its own consequence, so give it room. */
const REPLAY_STEP_CALL_MS = 120_000;
/** How long to wait after each action before the page is read, so a short timer can fire. */
export const AGAINST_WAIT_MS = 300;
/** The explorer's action budget on the reference. */
export const AGAINST_MAX_ACTIONS = 150;
/** The label of a replayed step that names no anchor. */
const UNNAMED_STEP = 'step';
const MSG_LEASE_FAILED = 'could not open a browser on';
const MSG_NO_DAEMON = 'could not reach the daemon on port';

/** The tab one run drives. */
export interface LeasedTab {
  url: string;
  sessionId: string;
  /** Release the lease when the run ends. */
  closeLease: boolean;
  confirmDangerous?: boolean;
}

/** The payload of a tool result: its structured content, or the JSON object in its text. */
function payloadOf(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if ('object' === typeof structured && null !== structured) {
    return structured as Record<string, unknown>;
  }
  const content = (result as { content?: unknown } | undefined)?.content;
  for (const part of Array.isArray(content) ? content : []) {
    const text = (part as { text?: unknown }).text;
    if ('string' !== typeof text) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if ('object' === typeof parsed && null !== parsed) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON; the next part may be.
    }
  }
  return {};
}

const asText = (value: unknown): string | undefined =>
  'string' === typeof value ? value : undefined;

/** A step that ran: it passed, or its action ran and only its declared consequence did not hold. */
function stepDone(step: Record<string, unknown> | undefined): boolean {
  if (step === undefined) {
    return false;
  }
  if (true === step['ok']) {
    return true;
  }
  const drift = step['drift'] as { reasonKind?: unknown } | undefined;
  const reason = asText(drift?.reasonKind);
  return reason !== undefined && isConsequenceDrift(reason as DriftReason);
}

/** One leased tab, as the compare driver. Every call goes through `reticle_run` on that tab. */
export function daemonDriver(caller: ToolCaller, tab: LeasedTab): CompareDriver {
  let sessionId = tab.sessionId;
  const run = async (
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ payload: Record<string, unknown>; refused: boolean }> => {
    const result = await caller.call(
      ReticleTool.RUN,
      { tool, args: { ...args, sessionId } },
      timeoutMs,
    );
    return { payload: payloadOf(result), refused: refusalText(result) !== undefined };
  };
  const snapshot = async (mode: SnapshotMode): Promise<Record<string, unknown>> =>
    (await run(ReticleTool.SNAPSHOT, { mode })).payload;
  return {
    async reset() {
      const { payload, refused } = await run(
        ReticleTool.NAVIGATE,
        { url: tab.url, timeout_ms: NAVIGATE_WAIT_MS },
        NAVIGATE_WAIT_MS * 2,
      );
      const next = asText(payload['sessionId']);
      if (next !== undefined) {
        sessionId = next;
      }
      return !refused && true === payload['ok'] && false !== payload['confirmed'];
    },
    async look() {
      const body = await snapshot(SnapshotMode.INTERACTIVE);
      const route = asText((body['status'] as { route?: unknown } | undefined)?.route);
      return { tree: asText(body['tree']) ?? '', ...(route === undefined ? {} : { route }) };
    },
    async read() {
      return asText((await snapshot(SnapshotMode.FULL))['tree']) ?? '';
    },
    async act(ref, action, value) {
      const { payload, refused } = await run(ReticleTool.ACT, {
        ref,
        action,
        args: value === undefined ? {} : { value },
      });
      return { ok: !refused && false !== payload['dispatched'], events: [] };
    },
    async replayStep(flow, index) {
      const { payload } = await run(
        ReticleTool.FLOW_REPLAY,
        {
          flowName: flow,
          to: index + 1,
          ...(0 === index ? {} : { at: index }),
          ...(true === tab.confirmDangerous ? { confirmDangerous: true } : {}),
        },
        REPLAY_STEP_CALL_MS,
      );
      const steps = Array.isArray(payload['steps']) ? payload['steps'] : [];
      const step = steps.map((s) => s as Record<string, unknown>).find((s) => index === s['step']);
      return { done: stepDone(step), label: asText(step?.['anchor']) ?? UNNAMED_STEP };
    },
    async close() {
      if (tab.closeLease) {
        await releaseLease(caller, sessionId);
      }
    },
  };
}

/** The saved flows a run replays, with `--select` applied, and how many steps each has. */
export async function flowsToReplay(
  fs: FileSystemPort,
  reticleRoot: string,
  select: readonly string[] | undefined,
  now: () => number,
): Promise<{ name: string; steps: number }[]> {
  const store = new FlowStore(fs, reticleRoot, { now });
  const files: FlowFile[] = [];
  for (const name of await store.list()) {
    const loaded = await store.load(name);
    if (loaded.ok) {
      files.push(loaded.value);
    }
  }
  const chosen = selectFlows(files, select === undefined ? {} : { labels: [...select] }).run;
  return chosen.map((flow) => ({ name: flow.name, steps: flow.steps.length }));
}

export interface VerifyAgainstOptions {
  port: number;
  candidate: string;
  reference: string;
  flows: readonly { name: string; steps: number }[];
  token?: string;
  /** The caller's project `.reticle`, where the leased tabs write their runs. */
  root?: string;
  confirmDangerous?: boolean;
  resultsJson?: string;
  sleep: (ms: number) => Promise<void>;
  /** Injected so a test can use its own transport. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
  write?: (path: string, text: string) => Promise<void>;
}

/** Compare the two builds through the daemon on `port`. Returns the lines to print and the exit code. */
export async function runVerifyAgainst(
  options: VerifyAgainstOptions,
): Promise<{ code: number; lines: string[] }> {
  const connect = options.connect ?? connectOverSse;
  let caller: ToolCaller;
  try {
    caller = await connect(endpointFor(options.port, options.token));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { code: 1, lines: [`${MSG_NO_DAEMON} ${String(options.port)}: ${why}`] };
  }
  const open = async (url: string): Promise<CompareDriver> => {
    const lease = await acquireLease(caller, url, false, options.root);
    if ('failed' in lease) {
      throw new Error([`${MSG_LEASE_FAILED} ${url}`, ...lease.failed].join('\n'));
    }
    return daemonDriver(caller, {
      url,
      sessionId: lease.leased,
      closeLease: true,
      ...(true === options.confirmDangerous ? { confirmDangerous: true } : {}),
    });
  };
  try {
    const result = await compareBuilds({
      reference: options.reference,
      candidate: options.candidate,
      open,
      flows: options.flows,
      maxActions: AGAINST_MAX_ACTIONS,
      wait: () => options.sleep(AGAINST_WAIT_MS),
    });
    const urls = { reference: options.reference, candidate: options.candidate };
    if (options.resultsJson !== undefined) {
      const write = options.write ?? ((path, text) => writeFile(path, text, 'utf8'));
      await write(options.resultsJson, `${JSON.stringify(compareJson(urls, result), null, 2)}\n`);
    }
    return { code: compareExit(result), lines: compareLines(urls, result) };
  } catch (error) {
    return { code: 1, lines: [error instanceof Error ? error.message : String(error)] };
  } finally {
    await caller.close().catch(() => undefined);
  }
}

/**
 * The command. It needs a daemon, as an agent does: `ensureDaemon` attaches to the one on the port,
 * or starts one. Nothing here stops a daemon, so an agent's MCP link stays up.
 */
export async function handleVerifyAgainst(
  parsed: {
    url: string;
    against: string;
    port: number;
    select?: string[];
    resultsJson?: string;
    confirmDangerous?: boolean;
  },
  ensureDaemon: (port: number) => Promise<void>,
  out: { line: (text: string) => void; fail: (text: string) => void; exit: (code: number) => void },
): Promise<void> {
  try {
    await ensureDaemon(parsed.port);
  } catch (error) {
    out.fail(error instanceof Error ? error.message : String(error));
    out.exit(1);
    return;
  }
  const cwd = process.cwd();
  const root = callerArtifactRoot(cwd);
  const token = readOrCreatePairingTokenSync(defaultPairingTokenDir());
  // The same `.reticle` the leased tabs replay from, so the list and the replay agree.
  const flows = await flowsToReplay(
    createNodeFileSystem(),
    root ?? join(cwd, ReticleDir.ROOT),
    parsed.select,
    Date.now,
  );
  const result = await runVerifyAgainst({
    port: parsed.port,
    candidate: parsed.url,
    reference: parsed.against,
    flows,
    ...(token === undefined || 0 === token.length ? {} : { token }),
    ...(root === undefined ? {} : { root }),
    ...(true === parsed.confirmDangerous ? { confirmDangerous: true } : {}),
    ...(parsed.resultsJson === undefined ? {} : { resultsJson: parsed.resultsJson }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  for (const line of result.lines) {
    out.line(line);
  }
  out.exit(result.code);
}
