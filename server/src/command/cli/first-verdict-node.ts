/**
 * The first verdict, wired to this machine: the dev server, the daemon and the Reticle browser.
 * Every decision is in `first-verdict.ts`; this file only gathers facts and runs effects.
 */
import { join } from 'node:path';
import {
  EventType,
  PredicateKind,
  QueryBy,
  ReticleTool,
  SnapshotMode,
  asRecord,
} from '@reticlehq/core';
import { OnboardingStop } from '@reticlehq/core/telemetry';
import type { ReticleEvent } from '@reticlehq/core';
import { RETICLE_VERIFY_DEFAULT_PORT } from '@/index.js';
import { DEV_SERVER_PORTS } from '@/command/cli/ports/resolve/cli-port.js';
import { WELL_KNOWN_RETICLE_PORTS } from '@/command/cli/ports/sibling-ports.js';
import { probeDevServerStates } from '@/portal/session/dev-server/dev-server-probe.js';
import {
  detectDevCommandInProject,
  type DevCommand,
} from '@/portal/session/dev-server/dev-command.js';
import { probePage } from '@/command/setup/node-effects.js';
import { startDevServerAndWait } from '@/command/setup/start-dev-server.js';
import {
  defaultPairingTokenDir,
  readOrCreatePairingTokenSync,
} from '@/portal/bridge/pairing-token.js';
import {
  acquireLease,
  connectOverSse,
  endpointFor,
  releaseLease,
  verdictOf,
  type ToolCaller,
} from '@/command/cli/adhoc-verdict.js';
import { ensureTryDaemon } from '@/command/cli/try-command.js';
import { writeFirstUseWarnings } from '@/command/cli/first-use-checks.js';
import {
  AppChoice,
  MSG_NO_APP,
  chooseApp,
  linksToOpen,
  pageFactsOf,
  runFirstVerdict,
  type FirstVerdictPorts,
  type FoundApp,
  type PageFacts,
  type SmokeFacts,
} from '@/command/cli/first-verdict.js';

/** How long a dev server this command started gets to serve its first page. */
const DEV_START_BUDGET_MS = 120_000;
/** How long a page gets to come back after a navigation, and to go quiet after it. */
const PAGE_ARRIVAL_MS = 15_000;
const PAGE_SETTLE_MS = 5_000;
const CALL_SLACK_MS = 5_000;
/** The most events read for one page, and the most links read off the start page. */
const EVENTS_READ = 500;
const LINKS_READ = 100;
const HREF = 'href';
/** The tool-call fields that carry each answer, for `verdictOf`. */
const NAV_FIELD = 'ok';
const EVENTS_FIELD = 'events';
const ELEMENTS_FIELD = 'elements';
const STATUS_FIELD = 'status';
/** `reticle_look` answers the find and the page read that the merged surface no longer names alone. */
const LOOK_FIND = 'find';
const LOOK_PAGE = 'page';
/** The bridge, the bench daemon and the verify endpoint. None of them is an app. */
const RETICLE_PORTS: ReadonlySet<number> = new Set([
  ...WELL_KNOWN_RETICLE_PORTS,
  RETICLE_VERIFY_DEFAULT_PORT,
]);
/** Only these events decide the smoke check. */
const SMOKE_EVENTS = [EventType.NET_REQUEST, EventType.CONSOLE_ERROR, EventType.ERROR_UNCAUGHT];

/** Start the folder's dev command and wait until it serves a page, or say why it did not. */
async function startDevServer(command: DevCommand, cwd: string): Promise<FoundApp> {
  const dir = command.directory === undefined ? cwd : join(cwd, command.directory);
  process.stdout.write(`Starting your dev server: ${command.command}\n`);
  const started = await startDevServerAndWait(command.command, dir, DEV_START_BUDGET_MS);
  return 'failed' in started
    ? { lines: [started.failed], stop: OnboardingStop.DEV_SERVER_FAILED }
    : { url: started.url, release: started.stop };
}

/** The app in `cwd`, or the one dev server that runs, started when it has to be. */
async function findApp(cwd: string): Promise<FoundApp> {
  const devCommand = detectDevCommandInProject(cwd);
  const pinned = devCommand?.port;
  const pinnedServing =
    pinned !== undefined && (await probePage(`http://localhost:${String(pinned)}`)).served;
  // Only outside an app folder: in one, another server is never the app to check.
  const running =
    devCommand === undefined
      ? (await probeDevServerStates([...DEV_SERVER_PORTS].filter((p) => !RETICLE_PORTS.has(p))))
          .serving
      : [];
  const choice = chooseApp({
    ...(devCommand === undefined ? {} : { devCommand }),
    pinnedServing,
    running,
  });
  if (AppChoice.USE === choice.action) {
    return { url: choice.url };
  }
  if (AppChoice.NONE === choice.action) {
    return choice;
  }
  // `chooseApp` starts a server only for a folder with a dev command.
  return devCommand === undefined
    ? { lines: MSG_NO_APP, stop: OnboardingStop.NO_WEB_APP }
    : startDevServer(devCommand, cwd);
}

/** One call through `reticle_run`, the route every tool profile has. */
function run(
  caller: ToolCaller,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  return caller.call(ReticleTool.RUN, { tool, args }, timeoutMs);
}

/** Wait for the page to go quiet, then read what its document did. */
async function readPage(
  caller: ToolCaller,
  sessionId: string,
  url: string,
  nav: { arrived: boolean; landedOn?: string },
): Promise<PageFacts> {
  // A page that never goes quiet is still judged on what it did: the wait only bounds the read.
  await run(
    caller,
    ReticleTool.WAIT_FOR,
    { predicate: { kind: PredicateKind.SETTLED }, timeout_ms: PAGE_SETTLE_MS, sessionId },
    PAGE_SETTLE_MS + CALL_SLACK_MS,
  ).catch(() => undefined);
  const observed = verdictOf(
    await run(caller, ReticleTool.OBSERVE, {
      sessionId,
      since: 0,
      filters: SMOKE_EVENTS,
      max_events: EVENTS_READ,
    }),
    EVENTS_FIELD,
  );
  const events = observed?.[EVENTS_FIELD];
  return pageFactsOf(url, Array.isArray(events) ? (events as ReticleEvent[]) : [], nav);
}

/** Go to `url` (or reload), and say whether the page came back and where. */
async function go(
  caller: ToolCaller,
  sessionId: string,
  url: string | undefined,
): Promise<{ arrived: boolean; landedOn?: string; sessionId: string }> {
  const args =
    url === undefined
      ? { reload: true, timeout_ms: PAGE_ARRIVAL_MS, sessionId }
      : { url, timeout_ms: PAGE_ARRIVAL_MS, sessionId };
  const result = asRecord(
    verdictOf(
      await caller.call(ReticleTool.NAVIGATE, args, PAGE_ARRIVAL_MS + CALL_SLACK_MS),
      NAV_FIELD,
    ),
  );
  const landedOn = result['landedOn'];
  const next = result['sessionId'];
  return {
    arrived: true === result['confirmed'],
    ...('string' === typeof landedOn ? { landedOn } : {}),
    sessionId: 'string' === typeof next ? next : sessionId,
  };
}

/** The path of the page on screen, from the page's own status. */
async function currentPath(caller: ToolCaller, sessionId: string): Promise<string | undefined> {
  const answer = verdictOf(
    await run(caller, ReticleTool.LOOK, {
      action: LOOK_PAGE,
      mode: SnapshotMode.STATUS,
      sessionId,
    }).catch(() => undefined),
    STATUS_FIELD,
  );
  const route = asRecord(answer?.[STATUS_FIELD])['route'];
  return 'string' === typeof route ? route : undefined;
}

/** The smoke check, through the daemon on `port`, in a Reticle browser with the zero-install reader. */
async function smokeThroughDaemon(
  port: number,
  url: string,
  headed: boolean,
): Promise<SmokeFacts | { failed: string[] }> {
  const unavailable = await ensureTryDaemon(port);
  if (unavailable !== undefined) {
    return { failed: [unavailable] };
  }
  const caller = await connectOverSse(
    endpointFor(port, readOrCreatePairingTokenSync(defaultPairingTokenDir())),
  );
  try {
    const opened = await acquireLease(caller, url, headed);
    if ('failed' in opened) {
      return opened;
    }
    try {
      // Reload once: the reader then runs from the start of the document, so it sees what the
      // first load did (a console error during start-up) and not only what came after.
      const back = await go(caller, opened.leased, undefined);
      const path = await currentPath(caller, back.sessionId);
      // The path only: the lease puts its own parameters on the url, and the page is not a link to open.
      const here = path === undefined ? url : new URL(new URL(path, url).pathname, url).href;
      const startNav = {
        arrived: back.arrived,
        ...(new URL(here).pathname === new URL(url).pathname ? {} : { landedOn: here }),
      };
      const start = await readPage(caller, back.sessionId, url, startNav);
      const found = verdictOf(
        await run(caller, ReticleTool.LOOK, {
          action: LOOK_FIND,
          by: QueryBy.ROLE,
          value: 'link',
          attrs: [HREF],
          limit: LINKS_READ,
          sessionId: back.sessionId,
        }),
        ELEMENTS_FIELD,
      );
      const elements = Array.isArray(found?.[ELEMENTS_FIELD]) ? found[ELEMENTS_FIELD] : [];
      const links = elements.flatMap((item: unknown) => {
        const element = asRecord(item);
        const href = asRecord(element['attrs'])[HREF];
        const name = element['name'];
        return 'string' === typeof href
          ? [{ name: 'string' === typeof name ? name : '', href }]
          : [];
      });
      const picked = linksToOpen(here, links);
      const visited: PageFacts[] = [];
      let sessionId = back.sessionId;
      for (const target of picked.open) {
        const nav = await go(caller, sessionId, target);
        sessionId = nav.sessionId;
        visited.push(await readPage(caller, sessionId, target, nav));
      }
      return { start, links: visited, linksFound: picked.found };
    } finally {
      await releaseLease(caller, opened.leased);
    }
  } finally {
    await caller.close().catch(() => undefined);
  }
}

/** Bare `reticle` in an unwired folder. Returns the exit code. `stop` records an onboarding stop. */
export async function cmdFirstVerdict(
  port: number,
  headed: boolean,
  stop: FirstVerdictPorts['stop'],
): Promise<number> {
  await writeFirstUseWarnings();
  return runFirstVerdict({
    findApp: () => findApp(process.cwd()),
    smoke: (url) => smokeThroughDaemon(port, url, headed),
    out: (line) => process.stdout.write(`${line}\n`),
    stop,
  });
}
