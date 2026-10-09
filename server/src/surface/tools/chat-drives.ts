/**
 * The daemon's side of the platform chat: the apps it reports, and the drives it takes.
 *
 * Out of `index.ts`, which only calls this and hands it the cloud credentials (the tool surface does
 * not reach `memory/cloud`; see `withLinkedCredential`): both halves share the same view of which tab is which
 * app, and keeping them together is what stops a drive attached to one app landing in another that
 * happens to be on the same port. See `local-apps.ts` and `remote-drive.ts` for each half.
 */
import { basename, dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import type { SessionInfo } from '../../portal/session/session-info.js';
import {
  LinkCapability,
  ReticleTool,
  asRecord,
  type LinkDevServer,
  type PresenterTone,
} from '@reticlehq/core';
import { prepareDrive } from '../../features/harness/platform/drive-target.js';
import { reticleToolset } from './harness-toolset.js';
import type { AttachedApp } from '../../features/harness/platform/remote-drive.js';
import type { ToolDeps } from './tool-kit.js';
import type { FileSystemPort } from '../../memory/project/fs/fs-port.js';
import { projectDirFor, sessionRoot } from '../../memory/project/session-root.js';
import { driveFrame } from '../../features/visual/visual-tools.js';
import { LEASE_ACQUIRE_TOOL } from './lease-tools.js';
import {
  REMOTE_DRIVE_JPEG_QUALITY,
  endDrivenTab,
  pickOwnDriveSession,
  startRemoteDrives,
} from '../../features/harness/platform/remote-drive.js';
import {
  appKeyOf,
  appsByPlatform,
  homeRelative,
  machineOf,
  mayOpen,
  NOT_AN_APP_ADDRESS,
  nameFromProjectId,
  pickAppTab,
  startAppReports,
} from '../../features/harness/platform/local-apps.js';
import { serverOptionsFromEnv } from '../../features/harness/platform/server-driver.js';
import { driveForChat } from './explore-tools.js';
import { withLinkedCredential } from './harness-explore.js';
import { runTool } from './invoke-tool.js';
import { announcedChannels, recordedGaps } from '../../portal/session/recorded-gaps.js';
import { probeDevServers } from '../../portal/session/dev-server/dev-server-probe.js';

/** Why a platform drive with no tab of its own runs no tool. */
const NO_DRIVEN_TAB = 'No tab was picked for this drive, so no tool runs.';

/** What this daemon does for the platform's chat. Each one is listed only once it is built. */
export const CHAT_CAPABILITIES: readonly LinkCapability[] = [
  LinkCapability.DRIVE_SPEC,
  LinkCapability.TARGET_TAB,
  LinkCapability.TARGET_HEADLESS,
  LinkCapability.TARGET_HEADED,
  LinkCapability.HUD,
  LinkCapability.TOOL_SESSION,
  LinkCapability.FRAMES,
];

/** The slice of the session manager this needs. */
export interface ChatDriveSessions {
  list(): SessionInfo[];
  count(): number;
  get(id: string):
    | {
        autoEnd(text: string, tone: PresenterTone): void;
        pushNarration(text: string): void;
        readonly sdkVersion?: string | undefined;
        readonly channels?: readonly string[] | undefined;
        readonly sourceMapping?: boolean | undefined;
      }
    | undefined;
  /** The last page handshake the bridge refused, when there was one. */
  lastClosure?(): { at: number; reason: string } | undefined;
}

/** A project's own name: its package's, else its id's, else its folder's. */
const nameOf = async (
  fs: FileSystemPort,
  dir: string,
  projectId: string | undefined,
): Promise<string> => {
  try {
    const name = (JSON.parse(await fs.readFile(join(dir, 'package.json'))) as { name?: unknown })
      .name;
    if ('string' === typeof name && 0 < name.length) return name;
  } catch {
    // No package, or not JSON: the folder names it.
  }
  // Not mapped to a checkout (the daemon's shared `unmatched` directory): the id the SDK stamped.
  if (undefined !== projectId) return nameFromProjectId(projectId);
  return basename(dir) || dir;
};

export interface ChatDriveCloud {
  /** The platform and key a tab's own project is linked with, or undefined when it is not. */
  sessionCloud: (sessionId: string) => Promise<{ url: string; apiKey: string } | undefined>;
  version: string;
  /** Folders holding runs the platform never got (the sync daemon's last count). Absolute roots. */
  unsynced?: () => readonly { root: string; runs: number; linked: boolean }[];
}

/** How often the localhost dev-server scan may run: never more than this, however often we report. */
const DEV_SERVER_SCAN_EVERY_MS = 30_000;

/**
 * Dev servers listening on localhost with no connected Reticle page — an app that is up and not
 * instrumented, or not dialling. The same probe `doctor` and the no-session diagnosis use, cached.
 */
function devServerScan(
  connectedUrls: () => readonly string[],
  now: () => number,
): () => Promise<LinkDevServer[]> {
  let last: { at: number; ports: number[] } | undefined;
  return async () => {
    if (last === undefined || now() - last.at >= DEV_SERVER_SCAN_EVERY_MS)
      last = { at: now(), ports: await probeDevServers() };
    const connected = new Set(
      connectedUrls().map((url) => {
        try {
          return Number(new URL(url).port);
        } catch {
          return 0;
        }
      }),
    );
    return last.ports
      .filter((port) => !connected.has(port))
      .map((port) => ({ url: `http://${LOCALHOST_HOST}:${String(port)}`, port }));
  };
}

const LOCALHOST_HOST = 'localhost';

export function startChatDrives(
  deps: ToolDeps,
  sessions: ChatDriveSessions,
  fs: FileSystemPort,
  cloud: ChatDriveCloud,
  log: (line: string) => void,
): { stop: () => void } {
  const env = process.env;
  const machine = machineOf(hostname(), homedir());
  const sessionCloud = cloud.sessionCloud;
  const sessionKey = async (id: string): Promise<string | undefined> =>
    (await sessionCloud(id))?.apiKey;
  // ponytail: a tab whose project resolves to nothing counts as the daemon's own project here, as it
  // does for flows and runs; a per-tab "unresolved" app is the upgrade if that ever misleads.
  const appOf = (id: string): string | undefined => {
    try {
      const projectId = sessions.list().find((tab) => tab.sessionId === id)?.projectId;
      return appKeyOf(machine.id, projectDirFor(deps, id), projectId);
    } catch {
      return undefined;
    }
  };
  // Opened headless, like `reticle drive <url>`, through runTool so it is counted like any call.
  const openable = (url: string): void => {
    if (
      !mayOpen(
        url,
        sessions.list().map((tab) => tab.url),
      )
    )
      throw new Error(NOT_AN_APP_ADDRESS);
  };
  /**
   * The `.reticle` each reported app writes into, learned from its tabs. A tab the chat opens for an
   * app is leased into that root: resolved from the page alone, an app with no project id would land
   * in `unmatched/`, which nothing syncs.
   */
  const rootByApp = new Map<string, string>();
  const claimFor = (appKey: string | undefined): { root?: string } => {
    const root = appKey === undefined ? undefined : rootByApp.get(appKey);
    return root === undefined ? {} : { root };
  };
  const open = async (url: string, appKey?: string): Promise<void> => {
    openable(url);
    await runTool(LEASE_ACQUIRE_TOOL, deps, { url, ...claimFor(appKey) });
  };

  const pick = (
    goal: string,
    key: string,
    app: AttachedApp | undefined,
  ): Promise<string | null | undefined> =>
    undefined === app
      ? pickOwnDriveSession(sessions.list(), goal, key, sessionKey)
      : pickAppTab(
          app,
          goal,
          () => sessions.list(),
          appOf,
          (url) => open(url, app.key),
        ).then(async (id) =>
          // The app the platform named must be one this credential's project owns.
          'string' === typeof id && (await sessionKey(id)) !== key ? null : id,
        );
  const drives = startRemoteDrives({
    env: () => withLinkedCredential(deps, env),
    connected: () => 0 < sessions.count(),
    pick,
    // The spec's target and HUD, applied through the same counted tools an agent would call.
    prepare: ({ goal, apiKey, app, spec }) =>
      prepareDrive(spec, app?.url ?? undefined, {
        pickTab: () => pick(goal, apiKey, app),
        open: async (url, headed, hud) => {
          openable(url);
          const lease = asRecord(
            await runTool(LEASE_ACQUIRE_TOOL, deps, {
              url,
              ...(headed ? { headed } : {}),
              ...(hud === undefined ? {} : { hud }),
              ...claimFor(app?.key),
            }),
          );
          const id = lease['sessionId'];
          if ('string' !== typeof id) throw new Error(`could not open ${url}`);
          return id;
        },
        tuneHud: async (sessionId, hud) => {
          await reticleToolset(deps, { sessionId }).invoke(ReticleTool.SESSION_TUNE, { hud });
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    // A platform drive: Reticle's own tools on the driven tab, and nothing else. Locked, so a call
    // naming another tab still lands on this one; with no tab picked, nothing runs at all.
    session: (sessionId) => {
      if (sessionId === undefined)
        return { invoke: () => Promise.reject(new Error(NO_DRIVEN_TAB)) };
      const tools = reticleToolset(deps, { sessionId, locked: true });
      return { tools: tools.tools, invoke: (tool, args) => tools.invoke(tool, args) };
    },
    drive: async (goal, sessionId) => {
      const url = sessions.list().find((tab) => tab.sessionId === sessionId)?.url;
      const outcome = await driveForChat(deps, goal, sessionId);
      return url === undefined ? outcome : { ...outcome, url };
    },
    // The leased tab, or a desktop window's own capture. A web tab only the SDK reaches has no camera.
    frame: (sessionId) =>
      sessionId === undefined
        ? Promise.resolve(undefined)
        : driveFrame(deps, sessionId, REMOTE_DRIVE_JPEG_QUALITY),
    settle: (id, outcome) => endDrivenTab(id === undefined ? undefined : sessions.get(id), outcome),
    log,
  });

  const scanDevServers = devServerScan(
    () => sessions.list().map((tab) => tab.url),
    () => Date.now(),
  );
  const reports = startAppReports({
    machine,
    version: cloud.version,
    capabilities: CHAT_CAPABILITIES,
    apps: async () =>
      appsByPlatform(
        sessions.list().map((tab) => {
          const live = sessions.get(tab.sessionId);
          const sdkVersion = live?.sdkVersion;
          // What the page announced plus the gaps its verdicts paid for: what the dashboard's
          // coverage line and coding-agent prompt are built from.
          const channels = announcedChannels({
            id: tab.sessionId,
            channels: live?.channels,
            sourceMapping: live?.sourceMapping,
          });
          const gaps = recordedGaps(tab.sessionId).map(({ kind, missing, fix, seenAt }) => ({
            kind,
            missing,
            fix,
            seenAt,
          }));
          return {
            ...tab,
            ...(sdkVersion === undefined ? {} : { sdkVersion }),
            ...(0 === channels.length ? {} : { channels }),
            gaps,
          };
        }),
        serverOptionsFromEnv(await withLinkedCredential(deps, env)),
        machine.id,
        async (tab) => {
          const root = sessionRoot(deps, tab.sessionId);
          const dir = dirname(root);
          rootByApp.set(appKeyOf(machine.id, dir, tab.projectId), root);
          const platform = await sessionCloud(tab.sessionId);
          return {
            dir,
            name: await nameOf(fs, dir, tab.projectId),
            ...(undefined === platform
              ? {}
              : { platform: { url: platform.url.replace(/\/+$/, ''), apiKey: platform.apiKey } }),
          };
        },
      ),
    open,
    extras: async () => {
      const closure = sessions.lastClosure?.();
      const unsynced = cloud.unsynced?.() ?? [];
      return {
        devServers: await scanDevServers(),
        ...(closure === undefined
          ? {}
          : { helloFailure: { reason: closure.reason, at: closure.at } }),
        ...(0 === unsynced.length
          ? {}
          : {
              unsynced: unsynced.map((u) => ({ ...u, root: homeRelative(u.root, homedir()) })),
            }),
      };
    },
    drivePending: (platform) => void drives.tick(platform),
    // What the platform wants the person told: in the daemon's log, and on the HUD of each open tab
    // of that project, so somebody who never reads the log still sees "update Reticle".
    notify: (notice, platform) => {
      const line = `${notice.text}${notice.url === undefined ? '' : ` ${notice.url}`}`;
      log(`reticle: from the platform: ${line}`);
      void (async () => {
        for (const tab of sessions.list()) {
          const key = await sessionKey(tab.sessionId).catch(() => undefined);
          if (key === platform.apiKey) sessions.get(tab.sessionId)?.pushNarration(line);
        }
      })();
    },
    log,
  });
  // Once now, so the chat sees this machine's apps as soon as the daemon is up.
  void reports.tick();

  return {
    stop: () => {
      drives.stop();
      reports.stop();
    },
  };
}
