/**
 * `iris verify <url>` — one-shot, non-MCP verification. It boots the engine in drive mode (Iris owns
 * a browser pointed at the preview URL), waits for the in-page SDK to dial back, replays every saved
 * flow, renders the verdict, and exits 0 on pass / 1 otherwise. The same IrisRunner + verdict the MCP
 * and HTTP paths use — so a platform/CI agent that can only run a shell command (Lovable, Emergent,
 * GitHub Actions) gets a byte-identical artifact without speaking MCP.
 *
 * The orchestration (runVerify) is split from the live wiring (openLiveConnection) behind VerifyPorts,
 * so the decision logic — including the two honesty guards (no session, no flows ⇒ never a green pass)
 * — is unit-tested without launching a real browser.
 */

import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  IRIS_DEFAULT_PORT,
  IRIS_WS_PATH,
  isLoopbackHostname,
  IrisDir,
  RunAgentKind,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
  type IrisVerificationRun,
} from '@syrin/iris-protocol';
import { start, type RunningServer } from './index.js';
import { IrisRunner } from './runs/iris-runner.js';
import { createRunnerPort } from './runs/runner-port.js';
import { renderRunReport } from './runs/render-report.js';
import { BaselineStore } from './project/baselines.js';
import { RecordingStore } from './flows/recordings.js';
import { FlowStore } from './flows/flows.js';
import { ProjectStore } from './project/project-store.js';
import { AnnotationStore } from './flows/annotation-store.js';
import { createNodeFileSystem } from './project/fs-port.js';
import type { SessionManager } from './session/session-manager.js';
import type { ToolDeps } from './tools/tools.js';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const DEFAULT_SESSION_TIMEOUT_MS = 15_000;
const SESSION_POLL_MS = 250;
const DEFAULT_PROJECT_NAME = 'app';
const VERIFY_AGENT_ID = 'iris-cli';

const MSG_NO_SESSION =
  'No app connected — Iris drove the URL but no @syrin/iris-browser session dialed back.\n' +
  '  Make sure the SDK is in the build and iris.connect() runs on the preview page' +
  ' (for a non-localhost preview: allowNonLocalhost + a pairing token).';
const MSG_NO_FLOWS =
  'No saved flows to verify (.iris/flows is empty) — refusing to report a pass for verifying nothing.\n' +
  '  Record a flow first (iris_record_start → act → iris_flow_save), then re-run verify.';
const MSG_VERIFY_PREFIX = 'verify failed: ';

/** The live capabilities runVerify needs — faked in tests so the logic runs without a browser. */
export interface VerifyConnection {
  /** Resolve true once a browser session has connected, or false at timeout. */
  sessionReady(timeoutMs: number): Promise<boolean>;
  listFlows(): Promise<string[]>;
  verify(): Promise<IrisVerificationRun>;
  close(): Promise<void>;
}

export interface VerifyPorts {
  connect: () => Promise<VerifyConnection>;
  out: (line: string) => void;
  fail: (line: string) => void;
  exit: (code: number) => void;
}

export interface VerifyArgs {
  url: string;
  timeoutMs: number;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openConnection(ports: VerifyPorts): Promise<VerifyConnection | undefined> {
  try {
    return await ports.connect();
  } catch (error) {
    ports.fail(MSG_VERIFY_PREFIX + errMessage(error));
    ports.exit(EXIT_FAIL);
    return undefined;
  }
}

/** Orchestration: boot → wait for a session → replay flows → verdict → exit code. Browser-free. */
export async function runVerify(args: VerifyArgs, ports: VerifyPorts): Promise<void> {
  const conn = await openConnection(ports);
  if (conn === undefined) return;
  try {
    const ready = await conn.sessionReady(args.timeoutMs);
    if (!ready) {
      ports.fail(MSG_NO_SESSION);
      ports.exit(EXIT_FAIL);
      return;
    }
    const names = await conn.listFlows();
    if (names.length === 0) {
      ports.fail(MSG_NO_FLOWS);
      ports.exit(EXIT_FAIL);
      return;
    }
    const run = await conn.verify();
    ports.out(renderRunReport(run));
    ports.exit(run.verdict.status === VerdictStatus.PASS ? EXIT_PASS : EXIT_FAIL);
  } catch (error) {
    ports.fail(MSG_VERIFY_PREFIX + errMessage(error));
    ports.exit(EXIT_FAIL);
  } finally {
    await conn.close().catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSession(
  sessions: SessionManager,
  timeoutMs: number,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (sessions.count() > 0) return true;
    await delay(SESSION_POLL_MS);
  }
  return sessions.count() > 0;
}

/** Reconstruct the disk-backed ToolDeps over the live bridge + driven browser the daemon owns. */
function buildVerifyDeps(running: RunningServer, irisRoot: string, now: () => number): ToolDeps {
  const fs = createNodeFileSystem();
  const deps: ToolDeps = {
    sessions: running.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, irisRoot, { now }),
    annotations: new AnnotationStore(),
    project: new ProjectStore(fs, irisRoot, { now }),
    fs,
    irisRoot,
    now,
  };
  if (running.realInput !== undefined) deps.realInput = running.realInput;
  return deps;
}

interface LiveOpts {
  url: string;
  headless: boolean;
  irisRoot: string;
  projectName: string;
  now: () => number;
  storageState?: string;
}

/** Split a drive URL into its origin + whether it's loopback — decides token/injection pairing. */
export function urlParts(url: string): { origin?: string; loopback: boolean } {
  try {
    const u = new URL(url);
    return { origin: u.origin, loopback: isLoopbackHostname(u.hostname) };
  } catch {
    return { loopback: false };
  }
}

async function openLiveConnection(opts: LiveOpts): Promise<VerifyConnection> {
  // A localhost preview connects natively (the app's own iris.connect() is allowed on loopback), so the
  // bridge stays token-free. A HOSTED (non-localhost) preview is blocked by the SDK's connection policy
  // and rejected as a foreign origin — so there we pair via a one-shot token both the bridge and the
  // injected iris.connect() share, plus the preview's origin on the allow-list. That split is what makes
  // both "verify my dev server" and "verify a live Lovable URL" work from the same command.
  const { origin, loopback } = urlParts(opts.url);
  const pairing = loopback
    ? {}
    : (() => {
        const token = randomUUID();
        const bridgeUrl = `ws://localhost:${String(IRIS_DEFAULT_PORT)}${IRIS_WS_PATH}`;
        return {
          token,
          injectConnect: { token, url: bridgeUrl },
          ...(origin !== undefined ? { allowedOrigins: [origin] } : {}),
        };
      })();
  const running = await start({
    driveUrl: opts.url,
    headless: opts.headless,
    mcp: false,
    irisRoot: opts.irisRoot,
    now: opts.now,
    ...pairing,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });
  const deps = buildVerifyDeps(running, opts.irisRoot, opts.now);
  const runner = new IrisRunner(createRunnerPort(deps));
  return {
    sessionReady: (timeoutMs) => waitForSession(deps.sessions, timeoutMs, opts.now),
    listFlows: () => deps.flows.list(),
    verify: () =>
      runner.verify({
        project: { name: opts.projectName, framework: RunFramework.OTHER, previewUrl: opts.url },
        agent: { id: VERIFY_AGENT_ID, kind: RunAgentKind.OEM_PIPELINE },
        trigger: { kind: RunTrigger.OEM },
        profile: RunProfile.PROD_PREVIEW,
      }),
    close: () => running.close(),
  };
}

/** CLI entry — wires the live ports and runs the one-shot verification. Exits the process itself. */
export function handleVerify(parsed: {
  url: string;
  headless: boolean;
  timeoutMs?: number;
  storageState?: string;
}): void {
  const now = (): number => Date.now();
  const irisRoot = join(process.cwd(), IrisDir.ROOT);
  const projectName = basename(process.cwd()) || DEFAULT_PROJECT_NAME;
  const ports: VerifyPorts = {
    connect: () =>
      openLiveConnection({
        url: parsed.url,
        headless: parsed.headless,
        irisRoot,
        projectName,
        now,
        ...(parsed.storageState !== undefined ? { storageState: parsed.storageState } : {}),
      }),
    out: (line) => process.stdout.write(`${line}\n`),
    fail: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
  };
  void runVerify(
    { url: parsed.url, timeoutMs: parsed.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS },
    ports,
  );
}
